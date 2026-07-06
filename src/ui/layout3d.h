/*
 * layout3d.h — 3D force-directed layout with Barnes-Hut octree + LOD.
 *
 * Computes node positions server-side. Provides hierarchical levels:
 *   - Overview: cluster centroids (packages/folders), ~1K-10K nodes
 *   - Detail: individual nodes within a region, up to max_nodes
 *
 * Layout positions are cached in the project's SQLite database.
 */
#ifndef CBM_UI_LAYOUT3D_H
#define CBM_UI_LAYOUT3D_H

#include "store/store.h"
#include <stdbool.h>

/* ── Layout node (output) ─────────────────────────────────────── */

typedef struct {
    int64_t id;
    float x, y, z;
    const char *label; /* "Function", "File", etc. */
    const char *name;  /* display name */
    const char *qualified_name;
    const char *file_path; /* relative file path for tree reconstruction */
    float size;            /* visual size */
    uint32_t color;        /* 0xRRGGBB */
} cbm_layout_node_t;

/* ── Layout edge (output) ─────────────────────────────────────── */

typedef struct {
    int64_t source;     /* node id (JSON serializer) */
    int64_t target;     /* node id (JSON serializer) */
    int32_t source_idx; /* 0-based index into result->nodes (binary v2) */
    int32_t target_idx; /* 0-based index into result->nodes (binary v2) */
    const char *type;   /* "CALLS", "IMPORTS", etc. */
} cbm_layout_edge_t;

/* ── Layout result ────────────────────────────────────────────── */

typedef struct {
    cbm_layout_node_t *nodes;
    int node_count;
    cbm_layout_edge_t *edges;
    int edge_count;
    int total_nodes; /* total in project (may exceed returned) */
} cbm_layout_result_t;

/* ── API ──────────────────────────────────────────────────────── */

typedef enum {
    CBM_LAYOUT_OVERVIEW = 0, /* cluster centroids */
    CBM_LAYOUT_DETAIL = 1    /* individual nodes in region */
} cbm_layout_level_t;

/* Compute layout for a project.
 * center_node: QN of center (for detail level), NULL for overview
 * radius: hop distance from center (for detail level)
 * max_nodes: cap on returned nodes; <=0 means "no cap" (return every node).
 *   OVERVIEW additionally filters to min_degree >= 2 so huge graphs return a
 *   small hub-only preview while the full DETAIL payload is being built.
 *   If that filter matches nothing on a non-empty project (tiny graphs where
 *   no node reaches degree 2), it falls back to an unfiltered fetch so the
 *   preview is never empty. */
cbm_layout_result_t *cbm_layout_compute(cbm_store_t *store, const char *project,
                                        cbm_layout_level_t level, const char *center_node,
                                        int radius, int max_nodes);

/* Free a layout result. */
void cbm_layout_free(cbm_layout_result_t *result);

/* Serialize layout result to JSON string. Caller must free(). */
char *cbm_layout_to_json(const cbm_layout_result_t *result);

/* ── Binary wire format (v2) ──────────────────────────────────────
 *
 * Layout: little-endian, contiguous sections in the physical order below.
 *
 *   header (32 bytes):
 *     u32 magic        = 0x4C414233 ('LAB3')
 *     u32 version      = 2
 *     u32 node_count
 *     u32 edge_count
 *     u32 total_nodes  (total in project before any cap)
 *     u32 strings_size (length of strings table in bytes, padded to 4)
 *     u32 label_count  (entries in label index)
 *     u32 etype_count  (entries in edge-type index)
 *
 *   sections (physical order):
 *     i64[node_count]   node ids
 *     u32[edge_count]   edge src_idx (0-based index into the node arrays,
 *                       guaranteed < node_count by the serializer)
 *     u32[edge_count]   edge tgt_idx (same semantics)
 *     f32[node_count*3] positions (xyz interleaved)
 *     f32[node_count]   sizes
 *     u32[node_count]   colors (0xRRGGBB)
 *     u32[node_count]   name_off  (byte offset into strings table)
 *     u32[node_count]   path_off  (byte offset; 0 = no path)
 *     u32[node_count]   qn_off    (byte offset; 0 = no qn)
 *     u8 [node_count]   label_id  (index into label index)
 *     u8 [edge_count]   etype_id  (index into edge-type index)
 *     u8 [0-3]          zero pad to the next 4-byte boundary
 *     u32[label_count]  label string offsets
 *     u32[etype_count]  etype string offsets
 *     u8 [strings_size] NUL-terminated string bytes (zero-padded to 4)
 *
 * Alignment: header(32) + 8*node_count is 4-aligned, and the two u32 edge
 * index sections keep it that way, so every later f32/u32 section stays
 * 4-byte aligned and the frontend can map them directly as typed-array
 * views. The explicit pad after the u8 sections re-aligns for the u32
 * index tables.
 *
 * v1 → v2: the two edge sections were i64 node IDs in v1; v2 sends u32
 * node INDICES instead (halves the edge payload and saves the frontend an
 * id→index hash lookup per edge endpoint).
 *
 * Offset 0 in any name_off/path_off/qn_off field means "absent" — readers
 * must check for it before dereferencing.
 *
 * Returns malloc'd buffer; *out_size set to total byte length. */
void *cbm_layout_to_binary(const cbm_layout_result_t *result, size_t *out_size);

#endif /* CBM_UI_LAYOUT3D_H */
