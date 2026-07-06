/*
 * layout3d.c — Anchor-based 3D graph layout with local optimization.
 *
 * Strategy: structured first, then refined.
 *   1. Place nodes on a ring by directory cluster key (clean, sorted structure)
 *   2. Assign z from call depth (entry points at top, callees below)
 *   3. Run GENTLE local optimization: ForceAtlas2 with strong anchor springs
 *      that keep nodes near their initial positions while untangling overlaps
 *
 * The result: clean separated clusters (from the ring) with locally
 * optimized intra-cluster positions (from the force simulation).
 */
#include "foundation/constants.h"
#include "ui/layout3d.h"
#include "foundation/log.h"

#include <yyjson/yyjson.h>

#include <math.h>
#include <errno.h>
#include <stdlib.h>
#include <string.h>
#include <stdint.h>

/* ── Constants ────────────────────────────────────────────────── */

/* No hard cap — pass max_nodes <= 0 to fetch every node in the project.
 * The renderer (graph-ui) handles 1M+ via instanced/typed-array streaming.
 * CBM_UI_MAX_RENDER_NODES opts back into a cap (see render_node_limit). */
#define DEFAULT_MAX_NODES 0 /* 0 → unbounded; store query treats <=0 as no limit */
#define BH_THETA 1.2f
#define OCTREE_MAX_DEPTH 26   /* stop subdividing coincident points (OOM guard) */
#define OCTREE_MIN_HALF 1e-4f /* minimum octree cell half-size */

/* OVERVIEW keeps only nodes with degree >= this (hub-only preview). */
#define OVERVIEW_MIN_DEGREE 2

/* Local optimization: gentle, preserves structure */
#define LOCAL_REPULSION 8.0f
#define LOCAL_ATTRACTION 1.0f
#define LOCAL_ANCHOR_K 0.25f /* how strongly nodes stick to their anchor */
#define LOCAL_ITERATIONS 40
#define Z_DEPTH_SPACING 50.0f /* gentle z-layering per call depth */

/* cbm_store_batch_count_degrees builds a bound "?,?,..." IN clause into a fixed
 * 4KB buffer (~2045 placeholders max) but binds every id passed — so calling it
 * with more ids than fit silently drops the tail (their degree stays 0, which
 * here would masquerade as dead code). Feed it in safe-sized chunks. */
#define DEAD_DEGREE_CHUNK 500

/* ── Dead-code node-flag parsing ──────────────────────────────── */

typedef struct {
    bool is_entry;
    bool is_test;
    bool is_exported;
    bool is_route;
} node_flags_t;

/* Truthy across the representations properties_json may use (JSON bool, the
 * integer 1 sqlite/json_extract emits, or a "true"/"1" string). */
static bool json_truthy(yyjson_val *v) {
    if (!v)
        return false;
    if (yyjson_is_bool(v))
        return yyjson_get_bool(v);
    if (yyjson_is_int(v))
        return yyjson_get_int(v) != 0;
    if (yyjson_is_uint(v))
        return yyjson_get_uint(v) != 0;
    if (yyjson_is_real(v))
        return yyjson_get_real(v) != 0.0;
    if (yyjson_is_str(v)) {
        const char *s = yyjson_get_str(v);
        return s && s[0] && strcmp(s, "0") != 0 && strcmp(s, "false") != 0;
    }
    return false;
}

static node_flags_t parse_node_flags(const char *props_json) {
    node_flags_t f = {false, false, false, false};
    if (!props_json || !props_json[0])
        return f;
    yyjson_doc *d = yyjson_read(props_json, strlen(props_json), 0);
    if (!d)
        return f;
    yyjson_val *root = yyjson_doc_get_root(d);
    if (root && yyjson_is_obj(root)) {
        f.is_entry = json_truthy(yyjson_obj_get(root, "is_entry_point"));
        f.is_test = json_truthy(yyjson_obj_get(root, "is_test"));
        f.is_exported = json_truthy(yyjson_obj_get(root, "is_exported"));
        yyjson_val *rp = yyjson_obj_get(root, "route_path");
        if (rp && yyjson_is_str(rp)) {
            const char *s = yyjson_get_str(rp);
            f.is_route = s && s[0];
        }
    }
    yyjson_doc_free(d);
    return f;
}

/* ── Node colors/sizes ────────────────────────────────────────── */

/* Stellar spectral type colors — maps node degree to star color.
 * Follows real Hertzsprung-Russell distribution:
 *   M (red dwarf, 76% of stars) → low-degree leaf nodes
 *   K (orange)                  → slightly connected
 *   G (yellow, like our Sun)    → moderately connected
 *   F (yellow-white)            → well-connected
 *   A (white)                   → highly connected
 *   B (blue-white)              → hub nodes
 *   O (blue giant, 0.00003%)    → mega-hubs
 */
static uint32_t stellar_color(int degree) {
    if (degree <= 1)
        return 0xff6050; /* M — red dwarf */
    if (degree <= 3)
        return 0xff8855; /* late K — orange-red */
    if (degree <= 5)
        return 0xffa060; /* K — orange */
    if (degree <= 8)
        return 0xffc070; /* early K — warm orange */
    if (degree <= 12)
        return 0xffe080; /* G — yellow (Sun-like) */
    if (degree <= 18)
        return 0xfff0c0; /* F — yellow-white */
    if (degree <= 25)
        return 0xfff8e8; /* late A — warm white */
    if (degree <= 35)
        return 0xe8e8ff; /* A — white-blue */
    if (degree <= 50)
        return 0xc0d0ff; /* B — blue-white */
    return 0x80a0ff;     /* O — blue giant */
}

/* label-based colors removed — using stellar_color(degree) for graph rendering.
 * Label colors are handled in the frontend (lib/colors.ts) for sidebar/tooltips. */

static float size_for_label(const char *label) {
    if (!label)
        return 4.0f;
    if (strcmp(label, "Project") == 0)
        return 20.0f;
    if (strcmp(label, "Package") == 0)
        return 15.0f;
    if (strcmp(label, "Module") == 0)
        return 15.0f;
    if (strcmp(label, "Folder") == 0)
        return 12.0f;
    if (strcmp(label, "File") == 0)
        return 8.0f;
    if (strcmp(label, "Class") == 0)
        return 6.0f;
    if (strcmp(label, "Struct") == 0)
        return 6.0f;
    if (strcmp(label, "Interface") == 0)
        return 6.0f;
    if (strcmp(label, "Function") == 0)
        return 4.0f;
    if (strcmp(label, "Method") == 0)
        return 4.0f;
    return 4.0f;
}

static uint32_t fnv1a(const char *s) {
    uint32_t h = 2166136261u;
    if (!s)
        return h;
    while (*s) {
        h ^= (uint8_t)*s++;
        h *= 16777619u;
    }
    return h;
}

static float rand_float(uint32_t *seed) {
    *seed = (*seed) * 1103515245u + 12345u;
    return (float)((*seed >> 16) & 0x7FFF) / 32768.0f - 0.5f;
}

/* Optional render cap. Unset/invalid CBM_UI_MAX_RENDER_NODES means no cap
 * (return 0) — the fork default. A positive value is an explicit opt-in
 * ceiling for constrained hosts; there is no hard upper bound because the
 * frontend renders 1M+ nodes via instanced typed-array streaming. */
static int render_node_limit(void) {
    const char *raw = getenv("CBM_UI_MAX_RENDER_NODES");
    if (!raw || !raw[0]) {
        return DEFAULT_MAX_NODES;
    }
    errno = 0;
    char *end = NULL;
    long v = strtol(raw, &end, 10);
    if (errno != 0 || end == raw || *end != '\0' || v <= 0) {
        return DEFAULT_MAX_NODES;
    }
    if (v > 0x7fffffff) {
        return 0x7fffffff;
    }
    return (int)v;
}

/* <=0 requested means "unbounded" unless the env cap opts in. */
static int clamp_max_nodes(int requested) {
    int cap = render_node_limit();
    if (cap <= 0) {
        return requested; /* no cap configured — pass through, incl. <=0 */
    }
    if (requested <= 0 || requested > cap) {
        return cap;
    }
    return requested;
}

/* ── Barnes-Hut Octree ────────────────────────────────────────── */

typedef struct octree_node {
    float cx, cy, cz, total_mass, half_size, ox, oy, oz;
    int body_index;
    float body_mass;
    struct octree_node *children[8];
} octree_node_t;

static octree_node_t *octree_new(float ox, float oy, float oz, float half) {
    octree_node_t *n = calloc(CBM_ALLOC_ONE, sizeof(*n));
    if (!n)
        return NULL;
    n->ox = ox;
    n->oy = oy;
    n->oz = oz;
    n->half_size = half;
    n->body_index = -1;
    return n;
}
static void octree_free(octree_node_t *n) {
    if (!n)
        return;
    for (int i = 0; i < 8; i++)
        octree_free(n->children[i]);
    free(n);
}
static int octant(octree_node_t *n, float x, float y, float z) {
    return ((x >= n->ox) ? 1 : 0) | ((y >= n->oy) ? 2 : 0) | ((z >= n->oz) ? 4 : 0);
}
static void child_center(octree_node_t *n, int o, float *cx, float *cy, float *cz) {
    float q = n->half_size * 0.5f;
    *cx = n->ox + ((o & 1) ? q : -q);
    *cy = n->oy + ((o & 2) ? q : -q);
    *cz = n->oz + ((o & 4) ? q : -q);
}
static void octree_insert(octree_node_t *n, int idx, float x, float y, float z, float mass,
                          int depth) {
    if (n->total_mass == 0.0f && n->body_index == -1) {
        n->body_index = idx;
        n->body_mass = mass;
        n->cx = x;
        n->cy = y;
        n->cz = z;
        n->total_mass = mass;
        return;
    }
    /* OOM guard: when bodies share (or nearly share) a position, subdivision
     * never separates them, so half_size shrinks toward zero and we allocate
     * octree cells without bound — the runaway that exhausted memory on large
     * graphs. Once we hit the depth/size floor, stop splitting and fold the body
     * into this cell as an aggregate (mass-weighted centroid). */
    if (depth >= OCTREE_MAX_DEPTH || n->half_size < OCTREE_MIN_HALF) {
        float nm = n->total_mass + mass;
        n->cx = (n->cx * n->total_mass + x * mass) / nm;
        n->cy = (n->cy * n->total_mass + y * mass) / nm;
        n->cz = (n->cz * n->total_mass + z * mass) / nm;
        n->total_mass = nm;
        n->body_index = -1;
        return;
    }
    if (n->body_index >= 0) {
        int oi = n->body_index;
        float ox = n->cx, oy = n->cy, oz = n->cz, om = n->body_mass;
        n->body_index = -1;
        int o = octant(n, ox, oy, oz);
        if (!n->children[o]) {
            float a, b, c;
            child_center(n, o, &a, &b, &c);
            n->children[o] = octree_new(a, b, c, n->half_size * 0.5f);
        }
        if (n->children[o])
            octree_insert(n->children[o], oi, ox, oy, oz, om, depth + 1);
    }
    float nm = n->total_mass + mass;
    n->cx = (n->cx * n->total_mass + x * mass) / nm;
    n->cy = (n->cy * n->total_mass + y * mass) / nm;
    n->cz = (n->cz * n->total_mass + z * mass) / nm;
    n->total_mass = nm;
    int o = octant(n, x, y, z);
    if (!n->children[o]) {
        float a, b, c;
        child_center(n, o, &a, &b, &c);
        n->children[o] = octree_new(a, b, c, n->half_size * 0.5f);
    }
    if (n->children[o])
        octree_insert(n->children[o], idx, x, y, z, mass, depth + 1);
}
static void octree_repulse(octree_node_t *n, float px, float py, float pz, float mm, int si,
                           float kr, float *fx, float *fy, float *fz) {
    if (!n || n->total_mass == 0.0f || n->body_index == si)
        return;
    float dx = px - n->cx, dy = py - n->cy, dz = pz - n->cz;
    float d = sqrtf(dx * dx + dy * dy + dz * dz);
    if (n->body_index >= 0 || (n->half_size * 2.0f / (d + 0.001f)) < BH_THETA) {
        if (d < 0.01f)
            d = 0.01f;
        float f = kr * mm * n->total_mass / d;
        *fx += f * dx / d;
        *fy += f * dy / d;
        *fz += f * dz / d;
        return;
    }
    for (int i = 0; i < 8; i++)
        octree_repulse(n->children[i], px, py, pz, mm, si, kr, fx, fy, fz);
}

/* ── Body with anchor ─────────────────────────────────────────── */

typedef struct {
    float x, y, z;
    float ax, ay, az; /* anchor position (from ring layout) */
    float fx, fy, fz;
    float mass;
} body_t;

/* ── Local optimization (gentle, anchor-preserving) ───────────── */

static void local_optimize(body_t *b, int n, const int *es, const int *ed, int ne) {
    for (int iter = 0; iter < LOCAL_ITERATIONS; iter++) {
        for (int i = 0; i < n; i++) {
            b[i].fx = 0;
            b[i].fy = 0;
            b[i].fz = 0;
        }

        /* Bounding box */
        float mnx = 1e9f, mny = 1e9f, mnz = 1e9f, mxx = -1e9f, mxy = -1e9f, mxz = -1e9f;
        for (int i = 0; i < n; i++) {
            if (b[i].x < mnx)
                mnx = b[i].x;
            if (b[i].y < mny)
                mny = b[i].y;
            if (b[i].z < mnz)
                mnz = b[i].z;
            if (b[i].x > mxx)
                mxx = b[i].x;
            if (b[i].y > mxy)
                mxy = b[i].y;
            if (b[i].z > mxz)
                mxz = b[i].z;
        }
        float half = fmaxf(fmaxf(mxx - mnx, mxy - mny), mxz - mnz) * 0.5f + 1.0f;

        /* Repulsion (Barnes-Hut) */
        octree_node_t *root =
            octree_new((mnx + mxx) * 0.5f, (mny + mxy) * 0.5f, (mnz + mxz) * 0.5f, half);
        if (!root)
            break;
        for (int i = 0; i < n; i++)
            octree_insert(root, i, b[i].x, b[i].y, b[i].z, b[i].mass, 0);
        for (int i = 0; i < n; i++)
            octree_repulse(root, b[i].x, b[i].y, b[i].z, b[i].mass, i, LOCAL_REPULSION, &b[i].fx,
                           &b[i].fy, &b[i].fz);
        octree_free(root);

        /* Attraction (edges) */
        for (int e = 0; e < ne; e++) {
            int s = es[e], t = ed[e];
            if (s < 0 || s >= n || t < 0 || t >= n)
                continue;
            float dx = b[t].x - b[s].x, dy = b[t].y - b[s].y, dz = b[t].z - b[s].z;
            b[s].fx += dx * LOCAL_ATTRACTION;
            b[s].fy += dy * LOCAL_ATTRACTION;
            b[s].fz += dz * LOCAL_ATTRACTION;
            b[t].fx -= dx * LOCAL_ATTRACTION;
            b[t].fy -= dy * LOCAL_ATTRACTION;
            b[t].fz -= dz * LOCAL_ATTRACTION;
        }

        /* Anchor spring: pull back toward initial ring position */
        for (int i = 0; i < n; i++) {
            b[i].fx += (b[i].ax - b[i].x) * LOCAL_ANCHOR_K * b[i].mass;
            b[i].fy += (b[i].ay - b[i].y) * LOCAL_ANCHOR_K * b[i].mass;
            b[i].fz += (b[i].az - b[i].z) * LOCAL_ANCHOR_K * b[i].mass;
        }

        /* Apply with capped displacement */
        for (int i = 0; i < n; i++) {
            float fm = sqrtf(b[i].fx * b[i].fx + b[i].fy * b[i].fy + b[i].fz * b[i].fz);
            float speed = 1.0f;
            if (speed * fm > 8.0f)
                speed = 8.0f / (fm + 0.001f);
            b[i].x += b[i].fx * speed;
            b[i].y += b[i].fy * speed;
            b[i].z += b[i].fz * speed;
        }
    }
}

/* ── Call depth via BFS ───────────────────────────────────────── */

static void compute_call_depth(int n, const int *es, const int *ed, int ne, const char **labels,
                               int *depth) {
    for (int i = 0; i < n; i++)
        depth[i] = -1;
    int *q = malloc((size_t)n * sizeof(int));
    int head = 0, tail = 0;
    if (!q)
        return;

    /* Entry points at depth 0 */
    for (int i = 0; i < n; i++) {
        if (labels[i] && (strcmp(labels[i], "Route") == 0 || strcmp(labels[i], "File") == 0 ||
                          strcmp(labels[i], "Module") == 0 || strcmp(labels[i], "Package") == 0)) {
            depth[i] = 0;
            q[tail++] = i;
        }
    }
    if (tail == 0) {
        int *in_d = calloc((size_t)n, sizeof(int));
        if (in_d) {
            for (int e = 0; e < ne; e++) {
                int t = ed[e];
                if (t >= 0 && t < n)
                    in_d[t]++;
            }
            for (int i = 0; i < n; i++)
                if (in_d[i] == 0) {
                    depth[i] = 0;
                    q[tail++] = i;
                }
            free(in_d);
        }
    }
    while (head < tail) {
        int c = q[head++], cd = depth[c];
        for (int e = 0; e < ne; e++)
            if (es[e] == c) {
                int t = ed[e];
                if (t >= 0 && t < n && depth[t] == -1) {
                    depth[t] = cd + SKIP_ONE;
                    q[tail++] = t;
                }
            }
    }
    for (int i = 0; i < n; i++)
        if (depth[i] == -1)
            depth[i] = 0;
    free(q);
}

/* ── Helpers ──────────────────────────────────────────────────── */

static void free_edge_array(cbm_edge_t *edges, int count) {
    if (!edges)
        return;
    for (int i = 0; i < count; i++) {
        free((void *)edges[i].project);
        free((void *)edges[i].type);
        free((void *)edges[i].properties_json);
    }
    free(edges);
}

/* ── Node ID → index map (for O(log n) edge filtering) ───────── */

typedef struct {
    int64_t id;
    int idx;
} node_id_entry_t;

static int cmp_node_id_entry(const void *a, const void *b) {
    int64_t da = ((const node_id_entry_t *)a)->id;
    int64_t db = ((const node_id_entry_t *)b)->id;
    return (da > db) - (da < db);
}

static int find_node_index(const node_id_entry_t *map, int count, int64_t id) {
    int lo = 0;
    int hi = count - SKIP_ONE;
    while (lo <= hi) {
        int mid = lo + (hi - lo) / PAIR_LEN;
        if (map[mid].id == id) {
            return map[mid].idx;
        }
        if (map[mid].id < id) {
            lo = mid + SKIP_ONE;
        } else {
            hi = mid - SKIP_ONE;
        }
    }
    return CBM_NOT_FOUND;
}

/* ── Public API ───────────────────────────────────────────────── */

cbm_layout_result_t *cbm_layout_compute(cbm_store_t *store, const char *project,
                                        cbm_layout_level_t level, const char *center_node,
                                        int radius, int max_nodes) {
    if (!store || !project)
        return NULL;
    max_nodes = clamp_max_nodes(max_nodes);
    (void)center_node;
    (void)radius;

    /* 1. Query nodes.
     * Store treats limit==0 as "default 10". Use INT32_MAX when caller
     * asked for unbounded so we actually get every row.
     * OVERVIEW filters to min_degree >= 2 so huge graphs return a small
     * hub-only preview while the full DETAIL payload is being built. */
    cbm_search_params_t params;
    memset(&params, 0, sizeof(params));
    params.project = project;
    params.limit = (max_nodes > 0) ? max_nodes : 0x7fffffff;
    params.min_degree = (level == CBM_LAYOUT_OVERVIEW) ? OVERVIEW_MIN_DEGREE : -1;
    params.max_degree = -1;

    cbm_search_output_t search_out;
    memset(&search_out, 0, sizeof(search_out));
    if (cbm_store_search(store, &params, &search_out) != CBM_STORE_OK)
        return calloc(CBM_ALLOC_ONE, sizeof(cbm_layout_result_t));

    int n = search_out.count, total_count = search_out.total;
    if (level == CBM_LAYOUT_OVERVIEW) {
        /* Under the degree filter search_out.total counts only hubs, but
         * total_nodes is documented as "total in project before any cap".
         * The unfiltered count also gates the empty-preview fallback. */
        int project_total = cbm_store_count_nodes(store, project);
        if (project_total > total_count)
            total_count = project_total;
        if (n == 0 && project_total > 0) {
            /* Tiny project where no node reaches degree >= 2 — refetch
             * unfiltered so the preview is never empty. */
            cbm_store_search_free(&search_out);
            memset(&search_out, 0, sizeof(search_out));
            params.min_degree = -1;
            if (cbm_store_search(store, &params, &search_out) != CBM_STORE_OK)
                return calloc(CBM_ALLOC_ONE, sizeof(cbm_layout_result_t));
            n = search_out.count;
        }
    }
    if (n == 0) {
        cbm_store_search_free(&search_out);
        cbm_layout_result_t *r = calloc(CBM_ALLOC_ONE, sizeof(*r));
        if (r)
            r->total_nodes = total_count;
        return r;
    }

    /* 2. Build sorted node-ID → index map for O(log n) edge filtering */
    node_id_entry_t *id_map = malloc((size_t)n * sizeof(node_id_entry_t));
    if (!id_map) {
        cbm_store_search_free(&search_out);
        cbm_layout_result_t *r = calloc(CBM_ALLOC_ONE, sizeof(*r));
        if (r) {
            r->total_nodes = total_count;
        }
        return r;
    }
    for (int i = 0; i < n; i++) {
        id_map[i].id = search_out.results[i].node.id;
        id_map[i].idx = i;
    }
    qsort(id_map, (size_t)n, sizeof(node_id_entry_t), cmp_node_id_entry);

    /* 3. Query edges — filter during fetch via binary search (O(e log n)) */
    int *deg = calloc((size_t)n, sizeof(int));
    int mapped = 0;
    int edge_cap = CBM_SZ_256;
    cbm_edge_t *all_edges = malloc((size_t)edge_cap * sizeof(cbm_edge_t));
    int *es = malloc((size_t)edge_cap * sizeof(int));
    int *ed = malloc((size_t)edge_cap * sizeof(int));
    cbm_schema_info_t schema;
    memset(&schema, 0, sizeof(schema));
    if (deg && all_edges && es && ed &&
        cbm_store_get_schema(store, project, &schema) == CBM_STORE_OK) {
        for (int t = 0; t < schema.edge_type_count; t++) {
            cbm_edge_t *te = NULL;
            int tc = 0;
            if (cbm_store_find_edges_by_type(store, project, schema.edge_types[t].type, &te, &tc) ==
                CBM_STORE_OK) {
                for (int e = 0; e < tc; e++) {
                    int si = find_node_index(id_map, n, te[e].source_id);
                    int di = find_node_index(id_map, n, te[e].target_id);
                    if (si >= 0 && di >= 0) {
                        if (mapped >= edge_cap) {
                            int nc = edge_cap * PAIR_LEN;
                            cbm_edge_t *te2 = realloc(all_edges, (size_t)nc * sizeof(cbm_edge_t));
                            int *ts = realloc(es, (size_t)nc * sizeof(int));
                            int *td = realloc(ed, (size_t)nc * sizeof(int));
                            if (!te2 || !ts || !td) {
                                if (te2)
                                    all_edges = te2;
                                if (ts)
                                    es = ts;
                                if (td)
                                    ed = td;
                                free_edge_array(te + e, tc - e);
                                goto edges_done;
                            }
                            all_edges = te2;
                            es = ts;
                            ed = td;
                            edge_cap = nc;
                        }
                        all_edges[mapped] = te[e];
                        memset(&te[e], 0, sizeof(cbm_edge_t));
                        es[mapped] = si;
                        ed[mapped] = di;
                        deg[si]++;
                        deg[di]++;
                        mapped++;
                    } else {
                        free((void *)te[e].project);
                        free((void *)te[e].type);
                        free((void *)te[e].properties_json);
                    }
                }
                free(te);
            }
        }
    edges_done:
        cbm_store_schema_free(&schema);
    }
    free(id_map);

    /* 4. Call depth for z-axis */
    int *cdepth = calloc((size_t)n, sizeof(int));
    const char **lbls = malloc((size_t)n * sizeof(char *));
    if (lbls) {
        for (int i = 0; i < n; i++)
            lbls[i] = search_out.results[i].node.label;
        if (cdepth)
            compute_call_depth(n, es, ed, mapped, lbls, cdepth);
        free(lbls);
    }

    /* 5. Seed positions: ring by directory cluster key + z from call depth */
    body_t *bodies = calloc((size_t)n, sizeof(body_t));
    cbm_layout_result_t *result = calloc(CBM_ALLOC_ONE, sizeof(*result));
    if (!result || !bodies) {
        free(bodies);
        free(deg);
        free(es);
        free(ed);
        free(cdepth);
        cbm_layout_free(result);
        free_edge_array(all_edges, mapped);
        cbm_store_search_free(&search_out);
        return NULL;
    }
    result->nodes = calloc((size_t)n, sizeof(cbm_layout_node_t));
    result->node_count = n;
    result->total_nodes = total_count;

    /* True full-graph incoming degree for dead-code classification. This MUST
     * come from the store, not the sampled `mapped` edges built above: that set
     * drops any edge whose other endpoint falls outside the rendered
     * <=max_nodes window, which would falsely mark a sampled-in function as
     * having zero callers. */
    int64_t *node_ids = malloc((size_t)n * sizeof(int64_t));
    int *in_calls = calloc((size_t)n, sizeof(int));
    int *in_usage = calloc((size_t)n, sizeof(int));
    int *deg_dummy = calloc((size_t)n, sizeof(int));
    if (node_ids && in_calls && in_usage && deg_dummy) {
        for (int i = 0; i < n; i++)
            node_ids[i] = search_out.results[i].node.id;
        for (int off = 0; off < n; off += DEAD_DEGREE_CHUNK) {
            int cnt = (n - off < DEAD_DEGREE_CHUNK) ? (n - off) : DEAD_DEGREE_CHUNK;
            cbm_store_batch_count_degrees(store, node_ids + off, cnt, "CALLS", in_calls + off,
                                          deg_dummy + off);
            cbm_store_batch_count_degrees(store, node_ids + off, cnt, "USAGE", in_usage + off,
                                          deg_dummy + off);
        }
    }

    for (int i = 0; i < n; i++) {
        const cbm_node_t *sn = &search_out.results[i].node;
        const char *fp = sn->file_path ? sn->file_path : "";

        /* Cluster key = first 3 dir components */
        char ck[CBM_SZ_256] = {0};
        {
            const char *p = fp;
            int sl = 0, ki = 0;
            while (*p && ki < 255) {
                if (*p == '/') {
                    sl++;
                    if (sl >= 3)
                        break;
                }
                ck[ki++] = *p++;
            }
        }

        uint32_t h = fnv1a(ck);
        float angle = ((float)(h & 0xFFFF) / 65535.0f) * 6.2832f;
        float r = 500.0f + ((float)((h >> 16) & 0xFF) / 255.0f) * 250.0f;

        uint32_t seed = fnv1a(sn->qualified_name);
        float jitter = 40.0f;
        float px = r * cosf(angle) + rand_float(&seed) * jitter;
        float py = r * sinf(angle) + rand_float(&seed) * jitter;
        float pz = cdepth ? -(float)cdepth[i] * Z_DEPTH_SPACING : 0;

        bodies[i].x = px;
        bodies[i].y = py;
        bodies[i].z = pz;
        bodies[i].ax = px;
        bodies[i].ay = py;
        bodies[i].az = pz; /* anchor = initial pos */
        bodies[i].mass = (float)(deg[i] + 1);

        result->nodes[i].id = sn->id;
        result->nodes[i].label = sn->label ? strdup(sn->label) : NULL;
        result->nodes[i].name = sn->name ? strdup(sn->name) : NULL;
        result->nodes[i].qualified_name = sn->qualified_name ? strdup(sn->qualified_name) : NULL;
        result->nodes[i].file_path = sn->file_path ? strdup(sn->file_path) : NULL;
        result->nodes[i].start_line = sn->start_line;
        result->nodes[i].end_line = sn->end_line;
        result->nodes[i].color = stellar_color(deg[i]);
        /* Size: base from label + boost from degree (hubs are bigger stars) */
        float base_size = size_for_label(sn->label);
        float deg_boost = (deg[i] > 5) ? fminf((float)deg[i] * 0.3f, 10.0f) : 0;
        result->nodes[i].size = base_size + deg_boost;

        /* Dead-code classification. Only Function/Method are candidates; other
         * labels are structural. Default to non-dead (1) if the batch degree
         * query failed, so a query error never masquerades as dead code. */
        node_flags_t nf = parse_node_flags(sn->properties_json);
        bool is_fn =
            sn->label && (strcmp(sn->label, "Function") == 0 || strcmp(sn->label, "Method") == 0);
        bool testish = nf.is_test || (sn->file_path && cbm_is_test_file_path(sn->file_path));
        int ic = in_calls ? in_calls[i] : 1;
        int iu = in_usage ? in_usage[i] : 1;
        const char *status;
        if (!is_fn)
            status = "structural";
        else if (testish)
            status = "test";
        else if (nf.is_entry || nf.is_route)
            status = "entry";
        else if (nf.is_exported)
            status = "exported";
        else if (ic == 0 && iu == 0)
            status = "dead";
        else if (ic == 1)
            status = "single";
        else
            status = "normal";
        result->nodes[i].in_calls = ic;
        result->nodes[i].status = status;
    }

    /* 6. Gentle local optimization (anchor-preserving) */
    local_optimize(bodies, n, es, ed, mapped);

    /* 7. Copy positions */
    for (int i = 0; i < n; i++) {
        result->nodes[i].x = bodies[i].x;
        result->nodes[i].y = bodies[i].y;
        result->nodes[i].z = bodies[i].z;
    }

    /* 8. Output edges — node ids for the JSON serializer, node indices for
     * the binary v2 serializer (es/ed are already indices into the node
     * arrays, validated by the binary-search filter in step 3). */
    if (mapped > 0) {
        result->edges = calloc((size_t)mapped, sizeof(cbm_layout_edge_t));
        result->edge_count = mapped;
        for (int e = 0; e < mapped && result->edges; e++) {
            result->edges[e].source = search_out.results[es[e]].node.id;
            result->edges[e].target = search_out.results[ed[e]].node.id;
            result->edges[e].source_idx = es[e];
            result->edges[e].target_idx = ed[e];
            result->edges[e].type = all_edges[e].type ? strdup(all_edges[e].type) : NULL;
        }
    }

    free(bodies);
    free(deg);
    free(es);
    free(ed);
    free(cdepth);
    free(node_ids);
    free(in_calls);
    free(in_usage);
    free(deg_dummy);
    free_edge_array(all_edges, mapped);
    cbm_store_search_free(&search_out);
    return result;
}

void cbm_layout_free(cbm_layout_result_t *r) {
    if (!r)
        return;
    for (int i = 0; i < r->node_count; i++) {
        free((void *)r->nodes[i].label);
        free((void *)r->nodes[i].name);
        free((void *)r->nodes[i].qualified_name);
        free((void *)r->nodes[i].file_path);
    }
    free(r->nodes);
    for (int i = 0; i < r->edge_count; i++)
        free((void *)r->edges[i].type);
    free(r->edges);
    free(r);
}

/* ── Binary serializer ────────────────────────────────────────────
 *
 * Layout shape documented in layout3d.h. Highlights:
 *  - Struct-of-arrays so the frontend can map sections straight onto
 *    typed-array views and hand the position buffer to the GPU.
 *  - Label/edge-type strings are deduplicated into a u8 index (max 255).
 *  - name/path/qn are interned with a small hash table so repeated file
 *    paths and shared symbol names don't bloat the payload at 1M nodes.
 *  - Byte offset 0 in the strings block is the sentinel "absent" — readers
 *    must check for it. */

/* Power-of-two open-addressing hash table over interned strings.
 * Keys are NUL-terminated; values are u32 byte offsets into the strings
 * buffer. We use FNV-1a + linear probing — collisions are rare at our scale
 * (typical: ~10k unique names, table sized 64k). */
typedef struct {
    uint32_t hash;
    uint32_t off; /* 0 = empty slot */
} intern_slot_t;

typedef struct {
    char *bytes;
    size_t len;
    size_t cap;
    intern_slot_t *slots;
    size_t slot_mask; /* slot_count - 1, always power of two */
} intern_t;

static void intern_init(intern_t *it, size_t slot_count) {
    it->cap = 4096;
    it->bytes = malloc(it->cap);
    if (it->bytes) {
        it->bytes[0] = '\0';
    }
    it->len = 1; /* reserve offset 0 for the "absent" sentinel */
    it->slot_mask = slot_count - 1;
    it->slots = calloc(slot_count, sizeof(intern_slot_t));
}

static void intern_free(intern_t *it) {
    free(it->bytes);
    free(it->slots);
}

static uint32_t intern_add(intern_t *it, const char *s) {
    if (!s || !*s)
        return 0;
    if (!it->bytes || !it->slots)
        return 0;
    size_t l = strlen(s);
    /* FNV-1a 32-bit */
    uint32_t h = 2166136261u;
    for (size_t i = 0; i < l; i++) {
        h ^= (uint8_t)s[i];
        h *= 16777619u;
    }
    if (h == 0)
        h = 1; /* keep 0 distinguishable from "empty slot" */

    size_t mask = it->slot_mask;
    size_t i = h & mask;
    for (size_t probes = 0; probes <= mask; probes++) {
        intern_slot_t *slot = &it->slots[i];
        if (slot->off == 0) {
            /* Insert */
            if (it->len + l + 1 > it->cap) {
                size_t nc = it->cap;
                while (it->len + l + 1 > nc)
                    nc *= 2;
                char *nb = realloc(it->bytes, nc);
                if (!nb)
                    return 0;
                it->bytes = nb;
                it->cap = nc;
            }
            uint32_t off = (uint32_t)it->len;
            memcpy(it->bytes + it->len, s, l + 1);
            it->len += l + 1;
            slot->hash = h;
            slot->off = off;
            return off;
        }
        if (slot->hash == h && strcmp(it->bytes + slot->off, s) == 0) {
            return slot->off;
        }
        i = (i + 1) & mask;
    }
    return 0; /* table full — extremely unlikely with 64k slots */
}

/* Pick a hash-table size proportional to expected unique-string count.
 * We size for ~50% load factor. */
static size_t intern_slots_for(int node_count) {
    size_t hint = (size_t)(node_count > 0 ? node_count : 1) * 3;
    size_t s = 1024;
    while (s < hint)
        s <<= 1;
    if (s > (1u << 20))
        s = 1u << 20;
    return s;
}

/* Look up `s` in a small (<= 255 entries) string array. Returns the existing
 * index or appends and returns the new one. Returns -1 only on overflow. */
static int small_intern(const char **arr, uint8_t *count, const char *s) {
    if (!s)
        s = "";
    for (int j = 0; j < *count; j++) {
        if (strcmp(arr[j], s) == 0)
            return j;
    }
    if (*count >= 255)
        return -1;
    arr[*count] = s;
    return (*count)++;
}

void *cbm_layout_to_binary(const cbm_layout_result_t *r, size_t *out_size) {
    if (!r || !out_size)
        return NULL;
    *out_size = 0;

    int n = r->node_count;
    int e = r->edge_count;

    /* ── 1. Build label + edge-type indices ─────────────────────── */
    const char *labels[256];
    uint8_t labels_ct = 0;
    const char *etypes[256];
    uint8_t etypes_ct = 0;

    uint8_t *node_label_id = n > 0 ? malloc((size_t)n) : NULL;
    uint8_t *edge_etype_id = e > 0 ? malloc((size_t)e) : NULL;
    if ((n > 0 && !node_label_id) || (e > 0 && !edge_etype_id)) {
        free(node_label_id);
        free(edge_etype_id);
        return NULL;
    }

    for (int i = 0; i < n; i++) {
        int id = small_intern(labels, &labels_ct, r->nodes[i].label);
        node_label_id[i] = (uint8_t)(id < 0 ? 0 : id);
    }
    for (int i = 0; i < e; i++) {
        int id = small_intern(etypes, &etypes_ct, r->edges[i].type);
        edge_etype_id[i] = (uint8_t)(id < 0 ? 0 : id);
    }

    /* ── 2. Intern name/path/qn into the strings byte block ──────── */
    intern_t it;
    intern_init(&it, intern_slots_for(n));
    if (!it.bytes || !it.slots) {
        intern_free(&it);
        free(node_label_id);
        free(edge_etype_id);
        return NULL;
    }

    uint32_t *name_off = n > 0 ? malloc((size_t)n * sizeof(uint32_t)) : NULL;
    uint32_t *path_off = n > 0 ? malloc((size_t)n * sizeof(uint32_t)) : NULL;
    uint32_t *qn_off = n > 0 ? malloc((size_t)n * sizeof(uint32_t)) : NULL;
    if (n > 0 && (!name_off || !path_off || !qn_off)) {
        free(name_off);
        free(path_off);
        free(qn_off);
        intern_free(&it);
        free(node_label_id);
        free(edge_etype_id);
        return NULL;
    }
    for (int i = 0; i < n; i++) {
        name_off[i] = intern_add(&it, r->nodes[i].name);
        path_off[i] = intern_add(&it, r->nodes[i].file_path);
        qn_off[i] = intern_add(&it, r->nodes[i].qualified_name);
    }

    /* Also intern label + etype strings so they live in the same byte block
     * (parser only needs one base pointer). */
    uint32_t label_str_off[256] = {0};
    uint32_t etype_str_off[256] = {0};
    for (int j = 0; j < labels_ct; j++)
        label_str_off[j] = intern_add(&it, labels[j]);
    for (int j = 0; j < etypes_ct; j++)
        etype_str_off[j] = intern_add(&it, etypes[j]);

    /* ── 3. Compute layout: header + sections + strings ──────────── */
    size_t header_size = 32;
    size_t sec_node_ids = (size_t)n * 8;
    size_t sec_edge_src = (size_t)e * 4; /* v2: u32 node indices, not i64 ids */
    size_t sec_edge_tgt = (size_t)e * 4;
    size_t sec_positions = (size_t)n * 12;
    size_t sec_sizes = (size_t)n * 4;
    size_t sec_colors = (size_t)n * 4;
    size_t sec_name_off = (size_t)n * 4;
    size_t sec_path_off = (size_t)n * 4;
    size_t sec_qn_off = (size_t)n * 4;
    size_t sec_node_lbl = (size_t)n;
    size_t sec_edge_etype = (size_t)e;
    /* The u8 sections (node_lbl + edge_etype) end at an arbitrary byte; the
     * following u32 sections require 4-byte alignment. Insert a pad so the
     * frontend can wrap the strings tables as Uint32Array views directly. */
    size_t pre_u32_pad =
        (4 - ((sec_node_lbl + sec_edge_etype) & 3u)) & 3u;
    size_t sec_label_idx = (size_t)labels_ct * 4;
    size_t sec_etype_idx = (size_t)etypes_ct * 4;
    size_t sec_strings = it.len;

    /* Pad strings table up to 4-byte alignment so total length stays nice. */
    size_t strings_padded = (sec_strings + 3) & ~(size_t)3;

    size_t total =
        header_size + sec_node_ids + sec_edge_src + sec_edge_tgt + sec_positions + sec_sizes +
        sec_colors + sec_name_off + sec_path_off + sec_qn_off + sec_node_lbl + sec_edge_etype +
        pre_u32_pad + sec_label_idx + sec_etype_idx + strings_padded;

    uint8_t *buf = malloc(total);
    if (!buf) {
        free(name_off);
        free(path_off);
        free(qn_off);
        intern_free(&it);
        free(node_label_id);
        free(edge_etype_id);
        return NULL;
    }
    memset(buf, 0, total);
    uint8_t *p = buf;

    /* Header (little-endian; we assume LE host, which matches every platform
     * this project supports — macOS/Linux/Windows on x86_64 and arm64). */
#define WRITE_U32(P, V)                                                                            \
    do {                                                                                           \
        uint32_t _v = (uint32_t)(V);                                                               \
        memcpy((P), &_v, 4);                                                                       \
    } while (0)
    WRITE_U32(p + 0, 0x4C414233u); /* 'LAB3' */
    WRITE_U32(p + 4, 2u);          /* v2: edge endpoints are u32 node indices */
    WRITE_U32(p + 8, (uint32_t)n);
    WRITE_U32(p + 12, (uint32_t)e);
    WRITE_U32(p + 16, (uint32_t)r->total_nodes);
    WRITE_U32(p + 20, (uint32_t)strings_padded);
    WRITE_U32(p + 24, (uint32_t)labels_ct);
    WRITE_U32(p + 28, (uint32_t)etypes_ct);
    p += header_size;

    /* Node IDs (int64) */
    for (int i = 0; i < n; i++) {
        int64_t v = r->nodes[i].id;
        memcpy(p, &v, 8);
        p += 8;
    }

    /* Edge src + tgt node indices (uint32). cbm_layout_compute always emits
     * indices in [0, node_count); clamp defensively so a malformed result
     * can never make the frontend read past its node arrays. */
    for (int i = 0; i < e; i++) {
        uint32_t v = (uint32_t)r->edges[i].source_idx;
        if (r->edges[i].source_idx < 0 || r->edges[i].source_idx >= n)
            v = 0;
        WRITE_U32(p, v);
        p += 4;
    }
    for (int i = 0; i < e; i++) {
        uint32_t v = (uint32_t)r->edges[i].target_idx;
        if (r->edges[i].target_idx < 0 || r->edges[i].target_idx >= n)
            v = 0;
        WRITE_U32(p, v);
        p += 4;
    }

    /* Positions (float32 × 3 per node) */
    for (int i = 0; i < n; i++) {
        float xyz[3] = {r->nodes[i].x, r->nodes[i].y, r->nodes[i].z};
        for (int j = 0; j < 3; j++) {
            if (!isfinite(xyz[j]))
                xyz[j] = 0.0f;
        }
        memcpy(p, xyz, 12);
        p += 12;
    }

    /* Sizes (float32) */
    for (int i = 0; i < n; i++) {
        float sz = r->nodes[i].size;
        if (!isfinite(sz))
            sz = 1.0f;
        memcpy(p, &sz, 4);
        p += 4;
    }

    /* Colors (uint32) */
    for (int i = 0; i < n; i++) {
        WRITE_U32(p, r->nodes[i].color);
        p += 4;
    }

    /* Per-node string offsets (uint32) */
    if (n > 0)
        memcpy(p, name_off, sec_name_off);
    p += sec_name_off;
    if (n > 0)
        memcpy(p, path_off, sec_path_off);
    p += sec_path_off;
    if (n > 0)
        memcpy(p, qn_off, sec_qn_off);
    p += sec_qn_off;

    /* Per-node label id (uint8) */
    if (n > 0)
        memcpy(p, node_label_id, sec_node_lbl);
    p += sec_node_lbl;

    /* Per-edge type id (uint8) */
    if (e > 0)
        memcpy(p, edge_etype_id, sec_edge_etype);
    p += sec_edge_etype;

    /* Align to 4 bytes for the following u32 sections (buf was zeroed). */
    p += pre_u32_pad;

    /* Label string offsets (uint32) */
    for (int j = 0; j < labels_ct; j++) {
        WRITE_U32(p, label_str_off[j]);
        p += 4;
    }

    /* Edge-type string offsets (uint32) */
    for (int j = 0; j < etypes_ct; j++) {
        WRITE_U32(p, etype_str_off[j]);
        p += 4;
    }

    /* Strings bytes (NUL-terminated, offset 0 = absent) */
    if (it.len > 0)
        memcpy(p, it.bytes, it.len);
    /* Trailing alignment padding is already zeroed by the calloc-like memset. */

#undef WRITE_U32

    free(name_off);
    free(path_off);
    free(qn_off);
    intern_free(&it);
    free(node_label_id);
    free(edge_etype_id);

    *out_size = total;
    return buf;
}

char *cbm_layout_to_json(const cbm_layout_result_t *r) {
    if (!r)
        return NULL;
    yyjson_mut_doc *doc = yyjson_mut_doc_new(NULL);
    yyjson_mut_val *root = yyjson_mut_obj(doc);
    yyjson_mut_doc_set_root(doc, root);

    yyjson_mut_val *na = yyjson_mut_arr(doc);
    for (int i = 0; i < r->node_count; i++) {
        yyjson_mut_val *nd = yyjson_mut_obj(doc);
        yyjson_mut_obj_add_int(doc, nd, "id", r->nodes[i].id);
        double nx = isfinite(r->nodes[i].x) ? (double)r->nodes[i].x : 0.0;
        double ny = isfinite(r->nodes[i].y) ? (double)r->nodes[i].y : 0.0;
        double nz = isfinite(r->nodes[i].z) ? (double)r->nodes[i].z : 0.0;
        yyjson_mut_obj_add_real(doc, nd, "x", nx);
        yyjson_mut_obj_add_real(doc, nd, "y", ny);
        yyjson_mut_obj_add_real(doc, nd, "z", nz);
        if (r->nodes[i].label)
            yyjson_mut_obj_add_str(doc, nd, "label", r->nodes[i].label);
        if (r->nodes[i].name)
            yyjson_mut_obj_add_str(doc, nd, "name", r->nodes[i].name);
        if (r->nodes[i].file_path)
            yyjson_mut_obj_add_str(doc, nd, "file_path", r->nodes[i].file_path);
        if (r->nodes[i].qualified_name)
            yyjson_mut_obj_add_str(doc, nd, "qualified_name", r->nodes[i].qualified_name);
        if (r->nodes[i].start_line > 0)
            yyjson_mut_obj_add_int(doc, nd, "start_line", r->nodes[i].start_line);
        if (r->nodes[i].end_line > 0)
            yyjson_mut_obj_add_int(doc, nd, "end_line", r->nodes[i].end_line);
        double nsz = isfinite(r->nodes[i].size) ? (double)r->nodes[i].size : 1.0;
        yyjson_mut_obj_add_real(doc, nd, "size", nsz);
        char hex[CBM_SZ_8];
        snprintf(hex, sizeof(hex), "#%06x", r->nodes[i].color);
        yyjson_mut_obj_add_strcpy(doc, nd, "color", hex);
        yyjson_mut_obj_add_int(doc, nd, "in_calls", r->nodes[i].in_calls);
        if (r->nodes[i].status)
            yyjson_mut_obj_add_str(doc, nd, "status", r->nodes[i].status);
        yyjson_mut_arr_append(na, nd);
    }
    yyjson_mut_obj_add_val(doc, root, "nodes", na);

    yyjson_mut_val *ea = yyjson_mut_arr(doc);
    for (int i = 0; i < r->edge_count; i++) {
        yyjson_mut_val *ed = yyjson_mut_obj(doc);
        yyjson_mut_obj_add_int(doc, ed, "source", r->edges[i].source);
        yyjson_mut_obj_add_int(doc, ed, "target", r->edges[i].target);
        if (r->edges[i].type)
            yyjson_mut_obj_add_str(doc, ed, "type", r->edges[i].type);
        yyjson_mut_arr_append(ea, ed);
    }
    yyjson_mut_obj_add_val(doc, root, "edges", ea);
    yyjson_mut_obj_add_int(doc, root, "total_nodes", r->total_nodes);

    size_t len = 0;
    yyjson_write_err write_err = {0};
    char *json =
        yyjson_mut_write_opts(doc, YYJSON_WRITE_ALLOW_INVALID_UNICODE, NULL, &len, &write_err);
    yyjson_mut_doc_free(doc);
    if (!json) {
        char code[CBM_SZ_32];
        snprintf(code, sizeof(code), "%u", write_err.code);
        cbm_log_error("layout.json.fail", "code", code, "msg",
                      write_err.msg ? write_err.msg : "unknown");
    }
    return json;
}
