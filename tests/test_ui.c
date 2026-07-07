/*
 * test_ui.c — Tests for the graph visualization UI module.
 *
 * Covers: config persistence, embedded asset lookup, layout engine, and the
 * /api/layout.bin blob cache + ETag path (live-socket, ephemeral port).
 */
#include "../src/foundation/compat.h"
#include "../src/foundation/compat_fs.h"
#include "../src/foundation/compat_thread.h"
#include "test_framework.h"
#include "test_helpers.h"
#include "ui/config.h"
#include "ui/embedded_assets.h"
#include "ui/http_server.h"
#include "ui/layout3d.h"
#include "store/store.h"

#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#ifdef _WIN32
#include <winsock2.h>
#include <ws2tcpip.h>
typedef SOCKET tu_sock_t;
#define tu_sock_close closesocket
#define TU_SOCK_BAD INVALID_SOCKET
#else
#include <arpa/inet.h>
#include <netinet/in.h>
#include <sys/socket.h>
#include <unistd.h>
typedef int tu_sock_t;
#define tu_sock_close close
#define TU_SOCK_BAD (-1)
#include <sys/wait.h>
#endif

/* ── Config tests ─────────────────────────────────────────────── */

TEST(config_load_defaults) {
    /* Loading with no config file should give defaults */
    cbm_ui_config_t cfg;
    cfg.ui_enabled = true; /* set non-default to verify load overwrites */
    cfg.ui_port = 1234;

    /* Use a temp HOME to avoid touching real config */
    char tmpdir[256];
    snprintf(tmpdir, sizeof(tmpdir), "/tmp/cbm_test_config_XXXXXX");
    char *td = cbm_mkdtemp(tmpdir);
    ASSERT_NOT_NULL(td);

    char *old_home = getenv("HOME") ? strdup(getenv("HOME")) : NULL;
    cbm_setenv("HOME", td, 1);

    cbm_ui_config_load(&cfg);

    ASSERT_FALSE(cfg.ui_enabled);
    ASSERT_EQ(cfg.ui_port, 9749);

    /* Restore HOME */
    if (old_home) {
        cbm_setenv("HOME", old_home, 1);
        free(old_home);
    }

    PASS();
}

TEST(config_save_and_reload) {
    char tmpdir[256];
    snprintf(tmpdir, sizeof(tmpdir), "/tmp/cbm_test_config_XXXXXX");
    char *td = cbm_mkdtemp(tmpdir);
    ASSERT_NOT_NULL(td);

    char *old_home = getenv("HOME") ? strdup(getenv("HOME")) : NULL;
    cbm_setenv("HOME", td, 1);

    /* Save */
    cbm_ui_config_t cfg = {.ui_enabled = true, .ui_port = 8080};
    cbm_ui_config_save(&cfg);

    /* Reload */
    cbm_ui_config_t loaded;
    cbm_ui_config_load(&loaded);

    ASSERT_TRUE(loaded.ui_enabled);
    ASSERT_EQ(loaded.ui_port, 8080);

    if (old_home) {
        cbm_setenv("HOME", old_home, 1);
        free(old_home);
    }

    PASS();
}

TEST(config_overwrite) {
    char tmpdir[256];
    snprintf(tmpdir, sizeof(tmpdir), "/tmp/cbm_test_config_XXXXXX");
    char *td = cbm_mkdtemp(tmpdir);
    ASSERT_NOT_NULL(td);

    char *old_home = getenv("HOME") ? strdup(getenv("HOME")) : NULL;
    cbm_setenv("HOME", td, 1);

    /* Save with ui_enabled=true */
    cbm_ui_config_t cfg1 = {.ui_enabled = true, .ui_port = 9749};
    cbm_ui_config_save(&cfg1);

    /* Overwrite with ui_enabled=false */
    cbm_ui_config_t cfg2 = {.ui_enabled = false, .ui_port = 9749};
    cbm_ui_config_save(&cfg2);

    /* Reload should show false */
    cbm_ui_config_t loaded;
    cbm_ui_config_load(&loaded);
    ASSERT_FALSE(loaded.ui_enabled);

    if (old_home) {
        cbm_setenv("HOME", old_home, 1);
        free(old_home);
    }

    PASS();
}

TEST(config_corrupt_file) {
    char tmpdir[256];
    snprintf(tmpdir, sizeof(tmpdir), "/tmp/cbm_test_config_XXXXXX");
    char *td = cbm_mkdtemp(tmpdir);
    ASSERT_NOT_NULL(td);

    char *old_home = getenv("HOME") ? strdup(getenv("HOME")) : NULL;
    cbm_setenv("HOME", td, 1);

    /* Write garbage to config path */
    char path[1024];
    cbm_ui_config_path(path, (int)sizeof(path));

    /* Ensure directory exists (portable — no system("mkdir -p")) */
    char dir[1024];
    snprintf(dir, sizeof(dir), "%s/.cache/codebase-memory-mcp", td);
    cbm_mkdir_p(dir, 0755);

    FILE *f = fopen(path, "w");
    ASSERT_NOT_NULL(f);
    fprintf(f, "this is not json!!!");
    fclose(f);

    /* Should load defaults, not crash */
    cbm_ui_config_t cfg;
    cbm_ui_config_load(&cfg);
    ASSERT_FALSE(cfg.ui_enabled);
    ASSERT_EQ(cfg.ui_port, 9749);

    if (old_home) {
        cbm_setenv("HOME", old_home, 1);
        free(old_home);
    }

    PASS();
}

TEST(config_missing_fields) {
    char tmpdir[256];
    snprintf(tmpdir, sizeof(tmpdir), "/tmp/cbm_test_config_XXXXXX");
    char *td = cbm_mkdtemp(tmpdir);
    ASSERT_NOT_NULL(td);

    char *old_home = getenv("HOME") ? strdup(getenv("HOME")) : NULL;
    cbm_setenv("HOME", td, 1);

    /* Write JSON with only ui_port */
    char path[1024];
    cbm_ui_config_path(path, (int)sizeof(path));

    char dir[1024];
    snprintf(dir, sizeof(dir), "%s/.cache/codebase-memory-mcp", td);
    cbm_mkdir_p(dir, 0755);

    FILE *f = fopen(path, "w");
    ASSERT_NOT_NULL(f);
    fprintf(f, "{\"ui_port\": 5555}");
    fclose(f);

    cbm_ui_config_t cfg;
    cbm_ui_config_load(&cfg);
    ASSERT_FALSE(cfg.ui_enabled); /* defaults for missing field */
    ASSERT_EQ(cfg.ui_port, 5555); /* present field loaded */

    if (old_home) {
        cbm_setenv("HOME", old_home, 1);
        free(old_home);
    }

    PASS();
}

/* ── Embedded asset tests ─────────────────────────────────────── */

TEST(embedded_lookup_not_found) {
    /* With stub, everything should return NULL */
    const cbm_embedded_file_t *f = cbm_embedded_lookup("/nonexistent");
    ASSERT_NULL(f);
    PASS();
}

TEST(embedded_stub_count) {
    /* Stub should have 0 files */
    ASSERT_EQ(CBM_EMBEDDED_FILE_COUNT, 0);
    PASS();
}

/* ── Layout tests ─────────────────────────────────────────────── */

TEST(layout_empty_graph) {
    cbm_store_t *store = cbm_store_open_memory();
    ASSERT_NOT_NULL(store);

    /* No nodes in store → empty result */
    cbm_layout_result_t *r =
        cbm_layout_compute(store, "test-project", CBM_LAYOUT_OVERVIEW, NULL, 0, 100);
    ASSERT_NOT_NULL(r);
    ASSERT_EQ(r->node_count, 0);
    ASSERT_EQ(r->edge_count, 0);

    cbm_layout_free(r);
    cbm_store_close(store);
    PASS();
}

TEST(layout_single_node) {
    cbm_store_t *store = cbm_store_open_memory();
    ASSERT_NOT_NULL(store);

    cbm_store_upsert_project(store, "test", "/tmp/test");
    cbm_node_t node = {
        .project = "test",
        .label = "Function",
        .name = "main",
        .qualified_name = "test::main",
        .file_path = "main.c",
        .start_line = 1,
        .end_line = 10,
    };
    int64_t id = cbm_store_upsert_node(store, &node);
    ASSERT_GT(id, 0);

    cbm_layout_result_t *r = cbm_layout_compute(store, "test", CBM_LAYOUT_OVERVIEW, NULL, 0, 100);
    ASSERT_NOT_NULL(r);
    ASSERT_EQ(r->node_count, 1);
    ASSERT_STR_EQ(r->nodes[0].name, "main");
    ASSERT_EQ(r->total_nodes, 1);

    cbm_layout_free(r);
    cbm_store_close(store);
    PASS();
}

TEST(layout_two_connected) {
    cbm_store_t *store = cbm_store_open_memory();
    ASSERT_NOT_NULL(store);

    cbm_store_upsert_project(store, "test", "/tmp/test");

    cbm_node_t n1 = {.project = "test",
                     .label = "Function",
                     .name = "foo",
                     .qualified_name = "test::foo",
                     .file_path = "a.c",
                     .start_line = 1,
                     .end_line = 5};
    cbm_node_t n2 = {.project = "test",
                     .label = "Function",
                     .name = "bar",
                     .qualified_name = "test::bar",
                     .file_path = "b.c",
                     .start_line = 1,
                     .end_line = 5};
    int64_t id1 = cbm_store_upsert_node(store, &n1);
    int64_t id2 = cbm_store_upsert_node(store, &n2);

    cbm_edge_t edge = {.project = "test", .source_id = id1, .target_id = id2, .type = "CALLS"};
    cbm_store_insert_edge(store, &edge);

    cbm_layout_result_t *r = cbm_layout_compute(store, "test", CBM_LAYOUT_OVERVIEW, NULL, 0, 100);
    ASSERT_NOT_NULL(r);
    ASSERT_EQ(r->node_count, 2);

    /* Nodes should be positioned apart (not at same point) */
    float dx = r->nodes[0].x - r->nodes[1].x;
    float dy = r->nodes[0].y - r->nodes[1].y;
    float dz = r->nodes[0].z - r->nodes[1].z;
    float dist = sqrtf(dx * dx + dy * dy + dz * dz);
    ASSERT_GT((long long)(dist * 100), 0);

    ASSERT_EQ(r->edge_count, 1);

    cbm_layout_free(r);
    cbm_store_close(store);
    PASS();
}

TEST(layout_respects_max_nodes) {
    cbm_store_t *store = cbm_store_open_memory();
    ASSERT_NOT_NULL(store);

    cbm_store_upsert_project(store, "test", "/tmp/test");

    /* Insert 20 nodes */
    for (int i = 0; i < 20; i++) {
        char name[32], qn[64];
        snprintf(name, sizeof(name), "fn%d", i);
        snprintf(qn, sizeof(qn), "test::fn%d", i);
        cbm_node_t n = {.project = "test",
                        .label = "Function",
                        .name = name,
                        .qualified_name = qn,
                        .file_path = "a.c",
                        .start_line = i,
                        .end_line = i + 1};
        cbm_store_upsert_node(store, &n);
    }

    /* max_nodes=5 should return at most 5 */
    cbm_layout_result_t *r = cbm_layout_compute(store, "test", CBM_LAYOUT_OVERVIEW, NULL, 0, 5);
    ASSERT_NOT_NULL(r);
    ASSERT_LTE(r->node_count, 5);
    ASSERT_EQ(r->total_nodes, 20);

    cbm_layout_free(r);
    cbm_store_close(store);
    PASS();
}

TEST(layout_clamps_render_cap_from_env) {
    cbm_store_t *store = cbm_store_open_memory();
    ASSERT_NOT_NULL(store);

    const char *old_raw = getenv("CBM_UI_MAX_RENDER_NODES");
    char *old_cap = old_raw ? strdup(old_raw) : NULL;
    cbm_setenv("CBM_UI_MAX_RENDER_NODES", "25", 1);

    cbm_store_upsert_project(store, "test", "/tmp/test");

    for (int i = 0; i < 40; i++) {
        char name[32], qn[64];
        snprintf(name, sizeof(name), "fn%d", i);
        snprintf(qn, sizeof(qn), "test::fn%d", i);
        cbm_node_t n = {.project = "test",
                        .label = "Function",
                        .name = name,
                        .qualified_name = qn,
                        .file_path = "a.c",
                        .start_line = i,
                        .end_line = i + 1};
        cbm_store_upsert_node(store, &n);
    }

    cbm_layout_result_t *r = cbm_layout_compute(store, "test", CBM_LAYOUT_OVERVIEW, NULL, 0, 50000);
    ASSERT_NOT_NULL(r);
    ASSERT_LTE(r->node_count, 25);
    ASSERT_EQ(r->total_nodes, 40);

    cbm_layout_free(r);
    cbm_store_close(store);
    if (old_cap) {
        cbm_setenv("CBM_UI_MAX_RENDER_NODES", old_cap, 1);
        free(old_cap);
    } else {
        cbm_unsetenv("CBM_UI_MAX_RENDER_NODES");
    }
    PASS();
}

TEST(layout_env_zero_uncaps) {
    /* CBM_UI_MAX_RENDER_NODES="0" is the explicit opt-in to unbounded:
     * every node comes back even when the caller passes max_nodes=0. */
    cbm_store_t *store = cbm_store_open_memory();
    ASSERT_NOT_NULL(store);

    const char *old_raw = getenv("CBM_UI_MAX_RENDER_NODES");
    char *old_cap = old_raw ? strdup(old_raw) : NULL;
    cbm_setenv("CBM_UI_MAX_RENDER_NODES", "0", 1);

    cbm_store_upsert_project(store, "test", "/tmp/test");
    for (int i = 0; i < 30; i++) {
        char name[32], qn[64];
        snprintf(name, sizeof(name), "fn%d", i);
        snprintf(qn, sizeof(qn), "test::fn%d", i);
        cbm_node_t n = {.project = "test",
                        .label = "Function",
                        .name = name,
                        .qualified_name = qn,
                        .file_path = "a.c",
                        .start_line = i,
                        .end_line = i + 1};
        cbm_store_upsert_node(store, &n);
    }

    cbm_layout_result_t *r = cbm_layout_compute(store, "test", CBM_LAYOUT_DETAIL, NULL, 0, 0);
    ASSERT_NOT_NULL(r);
    ASSERT_EQ(r->node_count, 30);
    ASSERT_EQ(r->total_nodes, 30);

    cbm_layout_free(r);
    cbm_store_close(store);
    if (old_cap) {
        cbm_setenv("CBM_UI_MAX_RENDER_NODES", old_cap, 1);
        free(old_cap);
    } else {
        cbm_unsetenv("CBM_UI_MAX_RENDER_NODES");
    }
    PASS();
}

TEST(layout_garbage_env_falls_back_to_default_cap) {
    /* An unparsable override must fall back to the safe default cap, not
     * to unbounded. Indistinguishable from uncapped at 30 nodes, so assert
     * via a small explicit request still working (clamp passthrough) and
     * the compute not rejecting the value. */
    cbm_store_t *store = cbm_store_open_memory();
    ASSERT_NOT_NULL(store);

    const char *old_raw = getenv("CBM_UI_MAX_RENDER_NODES");
    char *old_cap = old_raw ? strdup(old_raw) : NULL;
    cbm_setenv("CBM_UI_MAX_RENDER_NODES", "not-a-number", 1);

    cbm_store_upsert_project(store, "test", "/tmp/test");
    for (int i = 0; i < 30; i++) {
        char name[32], qn[64];
        snprintf(name, sizeof(name), "fn%d", i);
        snprintf(qn, sizeof(qn), "test::fn%d", i);
        cbm_node_t n = {.project = "test",
                        .label = "Function",
                        .name = name,
                        .qualified_name = qn,
                        .file_path = "a.c",
                        .start_line = i,
                        .end_line = i + 1};
        cbm_store_upsert_node(store, &n);
    }

    /* Explicit small cap still wins over the (large) default. */
    cbm_layout_result_t *r = cbm_layout_compute(store, "test", CBM_LAYOUT_DETAIL, NULL, 0, 7);
    ASSERT_NOT_NULL(r);
    ASSERT_LTE(r->node_count, 7);
    ASSERT_EQ(r->total_nodes, 30);
    cbm_layout_free(r);

    /* And max_nodes=0 under the default 200k cap returns all 30. */
    r = cbm_layout_compute(store, "test", CBM_LAYOUT_DETAIL, NULL, 0, 0);
    ASSERT_NOT_NULL(r);
    ASSERT_EQ(r->node_count, 30);
    cbm_layout_free(r);

    cbm_store_close(store);
    if (old_cap) {
        cbm_setenv("CBM_UI_MAX_RENDER_NODES", old_cap, 1);
        free(old_cap);
    } else {
        cbm_unsetenv("CBM_UI_MAX_RENDER_NODES");
    }
    PASS();
}

TEST(layout_call_depth_chain) {
    /* File seeds depth 0; a→b→c chain layers below it. */
    const char *labels[4] = {"File", "Function", "Function", "Function"};
    /* Edges: 0→1, 1→2, 2→3 */
    int es[3] = {0, 1, 2};
    int ed[3] = {1, 2, 3};
    int depth[4] = {-9, -9, -9, -9};
    cbm_layout_call_depth(4, es, ed, 3, labels, depth);
    ASSERT_EQ(depth[0], 0);
    ASSERT_EQ(depth[1], 1);
    ASSERT_EQ(depth[2], 2);
    ASSERT_EQ(depth[3], 3);
    PASS();
}

TEST(layout_call_depth_diamond_and_unreached) {
    /* Diamond 0→{1,2}→3 takes the shortest path; node 4 is unreached and
     * defaults to depth 0; an out-of-range edge endpoint is ignored. */
    const char *labels[5] = {"Module", "Function", "Function", "Function", "Function"};
    int es[5] = {0, 0, 1, 2, 3};
    int ed[5] = {1, 2, 3, 3, 99 /* out of range — dropped */};
    int depth[5];
    cbm_layout_call_depth(5, es, ed, 5, labels, depth);
    ASSERT_EQ(depth[0], 0);
    ASSERT_EQ(depth[1], 1);
    ASSERT_EQ(depth[2], 1);
    ASSERT_EQ(depth[3], 2);
    ASSERT_EQ(depth[4], 0);
    PASS();
}

TEST(layout_call_depth_no_entry_labels) {
    /* No Route/File/Module/Package labels → zero-in-degree nodes seed the
     * BFS. 0→1→2 with all Function labels: node 0 has in-degree 0. */
    const char *labels[3] = {"Function", "Function", "Function"};
    int es[2] = {0, 1};
    int ed[2] = {1, 2};
    int depth[3];
    cbm_layout_call_depth(3, es, ed, 2, labels, depth);
    ASSERT_EQ(depth[0], 0);
    ASSERT_EQ(depth[1], 1);
    ASSERT_EQ(depth[2], 2);
    PASS();
}

TEST(layout_call_depth_large_chain_fast) {
    /* 100k-node chain: O(n·e) BFS would do ~1e10 edge scans here (minutes);
     * the CSR path finishes in milliseconds. The suite-level timeout is the
     * regression tripwire. */
    enum { N = 100000 };
    const char **labels = calloc(N, sizeof(char *));
    int *es = malloc((N - 1) * sizeof(int));
    int *ed = malloc((N - 1) * sizeof(int));
    int *depth = malloc(N * sizeof(int));
    ASSERT_NOT_NULL(labels);
    ASSERT_NOT_NULL(es);
    ASSERT_NOT_NULL(ed);
    ASSERT_NOT_NULL(depth);
    labels[0] = "File";
    for (int i = 0; i < N - 1; i++) {
        labels[i + 1] = "Function";
        es[i] = i;
        ed[i] = i + 1;
    }
    cbm_layout_call_depth(N, es, ed, N - 1, labels, depth);
    ASSERT_EQ(depth[0], 0);
    ASSERT_EQ(depth[N - 1], N - 1);
    free((void *)labels);
    free(es);
    free(ed);
    free(depth);
    PASS();
}

TEST(layout_deterministic) {
    cbm_store_t *store = cbm_store_open_memory();
    ASSERT_NOT_NULL(store);

    cbm_store_upsert_project(store, "test", "/tmp/test");

    cbm_node_t n1 = {.project = "test",
                     .label = "Function",
                     .name = "alpha",
                     .qualified_name = "test::alpha",
                     .file_path = "a.c",
                     .start_line = 1,
                     .end_line = 5};
    cbm_node_t n2 = {.project = "test",
                     .label = "Function",
                     .name = "beta",
                     .qualified_name = "test::beta",
                     .file_path = "b.c",
                     .start_line = 1,
                     .end_line = 5};
    cbm_store_upsert_node(store, &n1);
    cbm_store_upsert_node(store, &n2);

    /* Run twice, check positions match */
    cbm_layout_result_t *r1 = cbm_layout_compute(store, "test", CBM_LAYOUT_OVERVIEW, NULL, 0, 100);
    cbm_layout_result_t *r2 = cbm_layout_compute(store, "test", CBM_LAYOUT_OVERVIEW, NULL, 0, 100);
    ASSERT_NOT_NULL(r1);
    ASSERT_NOT_NULL(r2);
    ASSERT_EQ(r1->node_count, r2->node_count);

    for (int i = 0; i < r1->node_count; i++) {
        ASSERT_FLOAT_EQ(r1->nodes[i].x, r2->nodes[i].x, 0.001);
        ASSERT_FLOAT_EQ(r1->nodes[i].y, r2->nodes[i].y, 0.001);
        ASSERT_FLOAT_EQ(r1->nodes[i].z, r2->nodes[i].z, 0.001);
    }

    cbm_layout_free(r1);
    cbm_layout_free(r2);
    cbm_store_close(store);
    PASS();
}

TEST(layout_to_json) {
    cbm_store_t *store = cbm_store_open_memory();
    ASSERT_NOT_NULL(store);

    cbm_store_upsert_project(store, "test", "/tmp/test");

    cbm_node_t n = {.project = "test",
                    .label = "Function",
                    .name = "hello",
                    .qualified_name = "test::hello",
                    .file_path = "a.c",
                    .start_line = 1,
                    .end_line = 5};
    cbm_store_upsert_node(store, &n);

    cbm_layout_result_t *r = cbm_layout_compute(store, "test", CBM_LAYOUT_OVERVIEW, NULL, 0, 100);
    ASSERT_NOT_NULL(r);

    char *json = cbm_layout_to_json(r);
    ASSERT_NOT_NULL(json);

    /* Should contain key fields */
    ASSERT(strstr(json, "\"nodes\"") != NULL);
    ASSERT(strstr(json, "\"edges\"") != NULL);
    ASSERT(strstr(json, "\"total_nodes\"") != NULL);
    ASSERT(strstr(json, "\"hello\"") != NULL);
    ASSERT(strstr(json, "\"Function\"") != NULL);

    free(json);
    cbm_layout_free(r);
    cbm_store_close(store);
    PASS();
}

TEST(layout_to_binary_roundtrip) {
    /* Verify the binary layout format produced by cbm_layout_to_binary
     * matches the format the frontend parser expects: header magic, counts,
     * per-section sizes, 4-byte alignment before the strings table, and
     * round-trippable string offsets. */
    cbm_store_t *store = cbm_store_open_memory();
    ASSERT_NOT_NULL(store);
    cbm_store_upsert_project(store, "test", "/tmp/test");

    /* Three nodes, one edge — small enough to inspect by hand, large enough
     * to exercise multi-element arrays + edge offsets. */
    cbm_node_t a = {.project = "test",
                    .label = "Function",
                    .name = "alpha",
                    .qualified_name = "test::alpha",
                    .file_path = "a.c",
                    .start_line = 1,
                    .end_line = 5};
    cbm_node_t b = {.project = "test",
                    .label = "Function",
                    .name = "beta",
                    .qualified_name = "test::beta",
                    .file_path = "b.c",
                    .start_line = 1,
                    .end_line = 5};
    cbm_node_t c = {.project = "test",
                    .label = "Class",
                    .name = "Gamma",
                    .qualified_name = "test::Gamma",
                    .file_path = "c.c",
                    .start_line = 1,
                    .end_line = 5};
    int64_t ida = cbm_store_upsert_node(store, &a);
    int64_t idb = cbm_store_upsert_node(store, &b);
    int64_t idc = cbm_store_upsert_node(store, &c);
    ASSERT_GT(ida, 0);
    ASSERT_GT(idb, 0);
    ASSERT_GT(idc, 0);

    cbm_edge_t e1 = {.project = "test", .source_id = ida, .target_id = idb, .type = "CALLS"};
    cbm_store_insert_edge(store, &e1);

    cbm_layout_result_t *r =
        cbm_layout_compute(store, "test", CBM_LAYOUT_DETAIL, NULL, 0, 100);
    ASSERT_NOT_NULL(r);
    ASSERT_EQ(r->node_count, 3);
    ASSERT_EQ(r->edge_count, 1);

    size_t blob_size = 0;
    void *blob = cbm_layout_to_binary(r, &blob_size);
    ASSERT_NOT_NULL(blob);
    ASSERT_GT((long long)blob_size, 32);

    const uint8_t *p = (const uint8_t *)blob;
    uint32_t magic, version, node_count, edge_count, total_nodes, strings_size, label_count,
        etype_count;
    memcpy(&magic, p + 0, 4);
    memcpy(&version, p + 4, 4);
    memcpy(&node_count, p + 8, 4);
    memcpy(&edge_count, p + 12, 4);
    memcpy(&total_nodes, p + 16, 4);
    memcpy(&strings_size, p + 20, 4);
    memcpy(&label_count, p + 24, 4);
    memcpy(&etype_count, p + 28, 4);

    ASSERT_EQ((long long)magic, 0x4C414233);
    ASSERT_EQ((long long)version, 3);
    ASSERT_EQ((long long)node_count, 3);
    ASSERT_EQ((long long)edge_count, 1);
    ASSERT_EQ((long long)total_nodes, 3);
    /* Two distinct labels (Function, Class), one edge type (CALLS). */
    ASSERT_EQ((long long)label_count, 2);
    ASSERT_EQ((long long)etype_count, 1);

    /* v2 edge sections: u32 src_idx / u32 tgt_idx directly after the node-id
     * array. Resolve the indices through the node ids and check they point
     * at the edge we inserted (ida → idb). */
    int64_t node_ids[3];
    memcpy(node_ids, p + 32, sizeof(node_ids));
    uint32_t src_idx, tgt_idx;
    memcpy(&src_idx, p + 32 + 8 * 3, 4);
    memcpy(&tgt_idx, p + 32 + 8 * 3 + 4 * 1, 4);
    ASSERT_LT((long long)src_idx, 3);
    ASSERT_LT((long long)tgt_idx, 3);
    ASSERT_EQ(node_ids[src_idx], ida);
    ASSERT_EQ(node_ids[tgt_idx], idb);

    /* Total size matches what the parser will walk through. Layout:
     *   header(32) + ids(8N) + edge_src(4E) + edge_tgt(4E) + pos(12N) +
     *   sizes(4N) + colors(4N) + name_off(4N) + path_off(4N) + qn_off(4N) +
     *   in_calls(4N) + start_line(4N) + end_line(4N) +
     *   node_lbl(N) + status(N) + edge_etype(E) + pad + label_idx(4L) +
     *   etype_idx(4T) + strings_padded.
     * With N=3, E=1: pad = (4 - (3+3+1)) & 3 = 1. */
    size_t expected_min =
        32 + 8 * 3 + 4 * 1 + 4 * 1 + 12 * 3 + 4 * 3 + 4 * 3 + 4 * 3 + 4 * 3 + 4 * 3 + 4 * 3 +
        4 * 3 + 4 * 3 + 3 + 3 + 1 + 1 + 4 * 2 + 4 * 1;
    ASSERT_GTE((long long)blob_size, (long long)expected_min);

    /* v3 sections: verify start/end lines roundtrip for node 0 and that
     * every status byte is a valid enum (0..6). Section offsets follow the
     * layout arithmetic above. */
    {
        size_t off_u32_block = 32 + 8 * 3 + 4 * 1 + 4 * 1 + 12 * 3 + 4 * 3 + 4 * 3 + 4 * 3 +
                               4 * 3 + 4 * 3;
        uint32_t v_in_calls, v_start, v_end;
        memcpy(&v_in_calls, p + off_u32_block, 4);
        memcpy(&v_start, p + off_u32_block + 4 * 3, 4);
        memcpy(&v_end, p + off_u32_block + 4 * 3 + 4 * 3, 4);
        ASSERT_EQ((long long)v_start, 1);
        ASSERT_EQ((long long)v_end, 5);
        (void)v_in_calls; /* value depends on classification; enum check below */
        const uint8_t *status_sec = p + off_u32_block + 3 * 4 * 3 + 3 /* node_lbl */;
        for (int i = 0; i < 3; i++) {
            ASSERT_LT((long long)status_sec[i], 7);
        }
    }

    /* The strings byte block lives at the tail of the blob (length
     * `strings_size`). Walk it looking for the sentinel names we inserted
     * to confirm interning happened. We use a manual scan rather than
     * memmem() because the latter is not portable across all platforms. */
    const uint8_t *strings = p + (blob_size - strings_size);
    const char *needles[] = {"alpha", "beta",  "Gamma",
                             "Function", "Class", "CALLS"};
    for (int i = 0; i < 6; i++) {
        size_t nl = strlen(needles[i]);
        int found = 0;
        for (size_t off = 0; off + nl <= strings_size; off++) {
            if (memcmp(strings + off, needles[i], nl) == 0) {
                found = 1;
                break;
            }
        }
        ASSERT(found);
    }

    free(blob);
    cbm_layout_free(r);
    cbm_store_close(store);
    PASS();
}

TEST(layout_to_binary_empty) {
    /* Empty store still produces a valid header-only blob. */
    cbm_store_t *store = cbm_store_open_memory();
    cbm_layout_result_t *r =
        cbm_layout_compute(store, "test", CBM_LAYOUT_DETAIL, NULL, 0, 100);
    ASSERT_NOT_NULL(r);
    ASSERT_EQ(r->node_count, 0);

    size_t blob_size = 0;
    void *blob = cbm_layout_to_binary(r, &blob_size);
    ASSERT_NOT_NULL(blob);
    ASSERT_GTE((long long)blob_size, 32);

    uint32_t magic, version;
    memcpy(&magic, blob, 4);
    memcpy(&version, (const uint8_t *)blob + 4, 4);
    ASSERT_EQ((long long)magic, 0x4C414233);
    ASSERT_EQ((long long)version, 3);

    free(blob);
    cbm_layout_free(r);
    cbm_store_close(store);
    PASS();
}

TEST(layout_overview_filters_low_degree) {
    /* One hub (degree 3) + three leaves (degree 1): OVERVIEW must return
     * only the degree >= 2 hub, while DETAIL returns everything. */
    cbm_store_t *store = cbm_store_open_memory();
    ASSERT_NOT_NULL(store);
    cbm_store_upsert_project(store, "test", "/tmp/test");

    cbm_node_t hub = {.project = "test",
                      .label = "Function",
                      .name = "hub",
                      .qualified_name = "test::hub",
                      .file_path = "hub.c",
                      .start_line = 1,
                      .end_line = 5};
    int64_t hub_id = cbm_store_upsert_node(store, &hub);
    ASSERT_GT(hub_id, 0);
    for (int i = 0; i < 3; i++) {
        char name[32], qn[64];
        snprintf(name, sizeof(name), "leaf%d", i);
        snprintf(qn, sizeof(qn), "test::leaf%d", i);
        cbm_node_t leaf = {.project = "test",
                           .label = "Function",
                           .name = name,
                           .qualified_name = qn,
                           .file_path = "leaf.c",
                           .start_line = i,
                           .end_line = i + 1};
        int64_t leaf_id = cbm_store_upsert_node(store, &leaf);
        cbm_edge_t edge = {
            .project = "test", .source_id = hub_id, .target_id = leaf_id, .type = "CALLS"};
        cbm_store_insert_edge(store, &edge);
    }

    cbm_layout_result_t *r = cbm_layout_compute(store, "test", CBM_LAYOUT_OVERVIEW, NULL, 0, 100);
    ASSERT_NOT_NULL(r);
    ASSERT_EQ(r->node_count, 1);
    ASSERT_STR_EQ(r->nodes[0].name, "hub");
    /* Leaves are filtered out, so hub→leaf edges have no surviving target. */
    ASSERT_EQ(r->edge_count, 0);
    /* total_nodes reports the whole project, not just the hubs. */
    ASSERT_EQ(r->total_nodes, 4);
    cbm_layout_free(r);

    cbm_layout_result_t *d = cbm_layout_compute(store, "test", CBM_LAYOUT_DETAIL, NULL, 0, 100);
    ASSERT_NOT_NULL(d);
    ASSERT_EQ(d->node_count, 4);
    ASSERT_EQ(d->edge_count, 3);
    cbm_layout_free(d);

    cbm_store_close(store);
    PASS();
}

TEST(layout_overview_fallback_when_no_hubs) {
    /* Every node has degree < 2, so the min_degree filter matches nothing.
     * OVERVIEW must fall back to an unfiltered fetch — never an empty
     * preview on a non-empty project. */
    cbm_store_t *store = cbm_store_open_memory();
    ASSERT_NOT_NULL(store);
    cbm_store_upsert_project(store, "test", "/tmp/test");

    cbm_node_t n1 = {.project = "test",
                     .label = "Function",
                     .name = "foo",
                     .qualified_name = "test::foo",
                     .file_path = "a.c",
                     .start_line = 1,
                     .end_line = 5};
    cbm_node_t n2 = {.project = "test",
                     .label = "Function",
                     .name = "bar",
                     .qualified_name = "test::bar",
                     .file_path = "b.c",
                     .start_line = 1,
                     .end_line = 5};
    int64_t id1 = cbm_store_upsert_node(store, &n1);
    int64_t id2 = cbm_store_upsert_node(store, &n2);
    cbm_edge_t edge = {.project = "test", .source_id = id1, .target_id = id2, .type = "CALLS"};
    cbm_store_insert_edge(store, &edge);

    cbm_layout_result_t *r = cbm_layout_compute(store, "test", CBM_LAYOUT_OVERVIEW, NULL, 0, 100);
    ASSERT_NOT_NULL(r);
    ASSERT_EQ(r->node_count, 2);
    ASSERT_EQ(r->edge_count, 1);
    ASSERT_EQ(r->total_nodes, 2);

    cbm_layout_free(r);
    cbm_store_close(store);
    PASS();
}

TEST(layout_null_inputs) {
    /* NULL store → NULL result */
    cbm_layout_result_t *r = cbm_layout_compute(NULL, "test", CBM_LAYOUT_OVERVIEW, NULL, 0, 100);
    ASSERT_NULL(r);

    /* NULL project → NULL result */
    cbm_store_t *store = cbm_store_open_memory();
    r = cbm_layout_compute(store, NULL, CBM_LAYOUT_OVERVIEW, NULL, 0, 100);
    ASSERT_NULL(r);

    /* cbm_layout_free(NULL) should not crash */
    cbm_layout_free(NULL);

    /* cbm_layout_to_json(NULL) should return NULL */
    char *json = cbm_layout_to_json(NULL);
    ASSERT_NULL(json);

    cbm_store_close(store);
    PASS();
}

/* ── /api/layout.bin cache + ETag (live socket) ───────────────────
 *
 * Minimal raw-socket client mirroring the harness in test_httpd.c —
 * one-shot exchanges against a real cbm_http_server_t on an ephemeral
 * port, reading until the server closes (Connection: close model). */

static tu_sock_t tu_connect(int port) {
#ifdef _WIN32
    WSADATA wsa;
    WSAStartup(MAKEWORD(2, 2), &wsa); /* refcounted; cleanup not needed in tests */
#endif
    tu_sock_t s = socket(AF_INET, SOCK_STREAM, 0);
    if (s == TU_SOCK_BAD)
        return TU_SOCK_BAD;
    struct sockaddr_in addr;
    memset(&addr, 0, sizeof(addr));
    addr.sin_family = AF_INET;
    addr.sin_port = htons((unsigned short)port);
    addr.sin_addr.s_addr = htonl(0x7F000001); /* 127.0.0.1 */
    if (connect(s, (struct sockaddr *)&addr, sizeof(addr)) != 0) {
        tu_sock_close(s);
        return TU_SOCK_BAD;
    }
    return s;
}

/* One-shot HTTP exchange. Returns response length, 0 on failure. */
static int tu_http(int port, const char *request, char *resp, size_t respsz) {
    tu_sock_t s = tu_connect(port);
    if (s == TU_SOCK_BAD)
        return 0;
    size_t req_len = strlen(request), off = 0;
    while (off < req_len) {
#ifdef _WIN32
        int n = send(s, request + off, (int)(req_len - off), 0);
#else
        ssize_t n = send(s, request + off, req_len - off, 0);
#endif
        if (n <= 0) {
            tu_sock_close(s);
            return 0;
        }
        off += (size_t)n;
    }
    off = 0;
    for (;;) {
#ifdef _WIN32
        int n = recv(s, resp + off, (int)(respsz - 1 - off), 0);
#else
        ssize_t n = recv(s, resp + off, respsz - 1 - off, 0);
#endif
        if (n <= 0)
            break;
        off += (size_t)n;
        if (off >= respsz - 1)
            break;
    }
    resp[off] = '\0';
    tu_sock_close(s);
    return (int)off;
}

/* HTTP status code from a raw response ("HTTP/1.1 200 ..."), or -1. */
static int tu_status(const char *resp) {
    if (strncmp(resp, "HTTP/1.1 ", 9) != 0)
        return -1;
    return atoi(resp + 9);
}

/* Copy a header value ("\r\nName: " prefix) out of a raw response head. */
static bool tu_header(const char *resp, const char *prefix, char *out, size_t outsz) {
    const char *h = strstr(resp, prefix);
    if (!h)
        return false;
    h += strlen(prefix);
    const char *end = strstr(h, "\r\n");
    if (!end || (size_t)(end - h) >= outsz)
        return false;
    memcpy(out, h, (size_t)(end - h));
    out[end - h] = '\0';
    return true;
}

static void *tu_server_thread(void *arg) {
    cbm_http_server_run((cbm_http_server_t *)arg);
    return NULL;
}

TEST(layout_bin_etag_and_cache) {
    /* Two identical requests must produce the same strong ETag (the second
     * one served from the handler-level blob cache), and a request that
     * presents the ETag via If-None-Match must get a 304 with no body. */
    char tmpdir[256];
    snprintf(tmpdir, sizeof(tmpdir), "/tmp/cbm_test_etag_XXXXXX");
    char *td = cbm_mkdtemp(tmpdir);
    ASSERT_NOT_NULL(td);

    /* Point the server's cache dir at the temp dir and create the project
     * DB where db_path_for_project() will look for it. */
    char *old_cache = getenv("CBM_CACHE_DIR") ? strdup(getenv("CBM_CACHE_DIR")) : NULL;
    cbm_setenv("CBM_CACHE_DIR", td, 1);

    char db_path[512];
    snprintf(db_path, sizeof(db_path), "%s/etagtest.db", td);
    cbm_store_t *store = cbm_store_open_path(db_path);
    ASSERT_NOT_NULL(store);
    cbm_store_upsert_project(store, "etagtest", "/tmp/etagtest");
    cbm_node_t n1 = {.project = "etagtest",
                     .label = "Function",
                     .name = "foo",
                     .qualified_name = "etagtest::foo",
                     .file_path = "a.c",
                     .start_line = 1,
                     .end_line = 5};
    cbm_node_t n2 = {.project = "etagtest",
                     .label = "Function",
                     .name = "bar",
                     .qualified_name = "etagtest::bar",
                     .file_path = "b.c",
                     .start_line = 1,
                     .end_line = 5};
    int64_t id1 = cbm_store_upsert_node(store, &n1);
    int64_t id2 = cbm_store_upsert_node(store, &n2);
    cbm_edge_t edge = {.project = "etagtest", .source_id = id1, .target_id = id2, .type = "CALLS"};
    cbm_store_insert_edge(store, &edge);
    cbm_store_close(store);

    cbm_http_server_t *srv = cbm_http_server_new(0);
    ASSERT_NOT_NULL(srv);
    cbm_thread_t tid;
    ASSERT_EQ(cbm_thread_create(&tid, 0, tu_server_thread, srv), 0);
    int port = cbm_http_server_port(srv);

    const char *get_req = "GET /api/layout.bin?project=etagtest HTTP/1.1\r\n\r\n";
    char resp1[16384], resp2[16384], resp3[4096];
    ASSERT_GT(tu_http(port, get_req, resp1, sizeof(resp1)), 0);
    ASSERT_EQ(tu_status(resp1), 200);
    char etag1[64], etag2[64];
    ASSERT_TRUE(tu_header(resp1, "\r\nETag: ", etag1, sizeof(etag1)));
    /* strong ETag shape: "<16 hex chars>" including the quotes */
    ASSERT_EQ((long long)strlen(etag1), 18);
    ASSERT_EQ(etag1[0], '"');
    ASSERT_EQ(etag1[17], '"');

    ASSERT_GT(tu_http(port, get_req, resp2, sizeof(resp2)), 0);
    ASSERT_EQ(tu_status(resp2), 200);
    ASSERT_TRUE(tu_header(resp2, "\r\nETag: ", etag2, sizeof(etag2)));
    ASSERT_STR_EQ(etag1, etag2);

    char req304[256];
    snprintf(req304, sizeof(req304),
             "GET /api/layout.bin?project=etagtest HTTP/1.1\r\n"
             "If-None-Match: %s\r\n\r\n",
             etag1);
    int n3 = tu_http(port, req304, resp3, sizeof(resp3));
    ASSERT_GT(n3, 0);
    ASSERT_EQ(tu_status(resp3), 304);
    ASSERT_NOT_NULL(strstr(resp3, "\r\nETag: "));
    ASSERT_NOT_NULL(strstr(resp3, "Content-Length: 0"));
    /* no body: the response ends right after the header terminator */
    const char *sep = strstr(resp3, "\r\n\r\n");
    ASSERT_NOT_NULL(sep);
    ASSERT_EQ((long long)(sep + 4 - resp3), (long long)n3);

    cbm_http_server_stop(srv);
    cbm_thread_join(&tid);
    cbm_http_server_free(srv);

    if (old_cache) {
        cbm_setenv("CBM_CACHE_DIR", old_cache, 1);
        free(old_cache);
    } else {
        cbm_setenv("CBM_CACHE_DIR", "", 1);
    }
    PASS();
}

/* ── Dead-code classification (distilled from PR #789) ────────── */

static const cbm_layout_node_t *find_layout_node(const cbm_layout_result_t *r, const char *name) {
    for (int i = 0; i < r->node_count; i++) {
        if (r->nodes[i].name && strcmp(r->nodes[i].name, name) == 0) {
            return &r->nodes[i];
        }
    }
    return NULL;
}

/* A function with zero callers/usages and no entry/test/exported flag is
 * "dead"; entry-point, test, and exported functions are NOT dead even at zero
 * callers; a called function reports its true full-graph incoming CALLS degree
 * ("single" at 1, "normal" at >=2). Non-Function labels are "structural". */
TEST(layout_dead_code_classification) {
    cbm_store_t *store = cbm_store_open_memory();
    ASSERT_NOT_NULL(store);
    ASSERT_EQ(cbm_store_upsert_project(store, "dc", "/tmp/dc"), CBM_STORE_OK);

    /* Candidates (Function, non-test path unless noted). */
    cbm_node_t dead = {.project = "dc",
                       .label = "Function",
                       .name = "deadfn",
                       .qualified_name = "dc::deadfn",
                       .file_path = "src/a.c",
                       .properties_json = "{\"is_entry_point\":false,\"is_test\":false,"
                                          "\"is_exported\":false}"};
    cbm_node_t entry = {.project = "dc",
                        .label = "Function",
                        .name = "entryfn",
                        .qualified_name = "dc::entryfn",
                        .file_path = "src/b.c",
                        .properties_json = "{\"is_entry_point\":true}"};
    cbm_node_t tst = {.project = "dc",
                      .label = "Function",
                      .name = "testfn",
                      .qualified_name = "dc::testfn",
                      .file_path = "src/c.c",
                      .properties_json = "{\"is_test\":true}"};
    cbm_node_t tstpath = {.project = "dc",
                          .label = "Function",
                          .name = "bypathfn",
                          .qualified_name = "dc::bypathfn",
                          .file_path = "tests/mod_helpers.c",
                          .properties_json = "{}"};
    cbm_node_t exp = {.project = "dc",
                      .label = "Function",
                      .name = "exportedfn",
                      .qualified_name = "dc::exportedfn",
                      .file_path = "src/d.c",
                      .properties_json = "{\"is_exported\":true}"};
    cbm_node_t single = {.project = "dc",
                         .label = "Function",
                         .name = "calledonce",
                         .qualified_name = "dc::calledonce",
                         .file_path = "src/e.c",
                         .properties_json = "{}"};
    cbm_node_t norm = {.project = "dc",
                       .label = "Function",
                       .name = "callednormal",
                       .qualified_name = "dc::callednormal",
                       .file_path = "src/f.c",
                       .properties_json = "{}"};
    cbm_node_t caller = {.project = "dc",
                         .label = "Function",
                         .name = "caller",
                         .qualified_name = "dc::caller",
                         .file_path = "src/g.c",
                         .properties_json = "{}"};
    /* A structural (non-Function) node is never a dead-code candidate. */
    cbm_node_t cls = {.project = "dc",
                      .label = "Class",
                      .name = "SomeClass",
                      .qualified_name = "dc::SomeClass",
                      .file_path = "src/h.c",
                      .properties_json = "{}"};

    int64_t id_dead = cbm_store_upsert_node(store, &dead);
    cbm_store_upsert_node(store, &entry);
    cbm_store_upsert_node(store, &tst);
    cbm_store_upsert_node(store, &tstpath);
    cbm_store_upsert_node(store, &exp);
    int64_t id_single = cbm_store_upsert_node(store, &single);
    int64_t id_norm = cbm_store_upsert_node(store, &norm);
    int64_t id_caller = cbm_store_upsert_node(store, &caller);
    cbm_store_upsert_node(store, &cls);
    ASSERT_GT(id_dead, 0);

    /* calledonce ← 1 CALLS; callednormal ← 2 CALLS (full-graph inbound). */
    cbm_edge_t e1 = {
        .project = "dc", .source_id = id_caller, .target_id = id_single, .type = "CALLS"};
    cbm_edge_t e2 = {
        .project = "dc", .source_id = id_caller, .target_id = id_norm, .type = "CALLS"};
    cbm_edge_t e3 = {.project = "dc", .source_id = id_dead, .target_id = id_norm, .type = "CALLS"};
    cbm_store_insert_edge(store, &e1);
    cbm_store_insert_edge(store, &e2);
    cbm_store_insert_edge(store, &e3);

    /* DETAIL: this test asserts classification across every node, and the
     * fork's OVERVIEW level filters to hubs (min_degree >= 2), which would
     * drop the low-degree fixtures under test. */
    cbm_layout_result_t *r = cbm_layout_compute(store, "dc", CBM_LAYOUT_DETAIL, NULL, 0, 100);
    ASSERT_NOT_NULL(r);

    const cbm_layout_node_t *ln;

    ln = find_layout_node(r, "deadfn");
    ASSERT_NOT_NULL(ln);
    ASSERT_STR_EQ(ln->status, "dead");
    ASSERT_EQ(ln->in_calls, 0);

    ln = find_layout_node(r, "entryfn");
    ASSERT_NOT_NULL(ln);
    ASSERT_STR_EQ(ln->status, "entry");

    ln = find_layout_node(r, "testfn");
    ASSERT_NOT_NULL(ln);
    ASSERT_STR_EQ(ln->status, "test");

    ln = find_layout_node(r, "bypathfn"); /* test detected via file path */
    ASSERT_NOT_NULL(ln);
    ASSERT_STR_EQ(ln->status, "test");

    ln = find_layout_node(r, "exportedfn");
    ASSERT_NOT_NULL(ln);
    ASSERT_STR_EQ(ln->status, "exported");

    ln = find_layout_node(r, "calledonce");
    ASSERT_NOT_NULL(ln);
    ASSERT_STR_EQ(ln->status, "single");
    ASSERT_EQ(ln->in_calls, 1);

    ln = find_layout_node(r, "callednormal");
    ASSERT_NOT_NULL(ln);
    ASSERT_STR_EQ(ln->status, "normal");
    ASSERT_EQ(ln->in_calls, 2);

    ln = find_layout_node(r, "SomeClass");
    ASSERT_NOT_NULL(ln);
    ASSERT_STR_EQ(ln->status, "structural");

    /* The classification must survive JSON serialization. */
    char *json = cbm_layout_to_json(r);
    ASSERT_NOT_NULL(json);
    ASSERT(strstr(json, "\"status\":\"dead\"") != NULL);
    ASSERT(strstr(json, "\"in_calls\":2") != NULL);
    free(json);

    cbm_layout_free(r);
    cbm_store_close(store);
    PASS();
}

/* ── Octree recursion guard (distilled from PR #821; refs #498/#726/#402) ── */

/* Bodies that share a position made octree_insert subdivide forever — the
 * cell around them shrinks but never separates them, so one octree cell is
 * calloc'd per level until the process dies (stack overflow) or freezes the
 * machine allocating (the 34GB-swap reports). Fixed by the depth/half-size
 * floor in src/ui/layout3d.c (OCTREE_MAX_DEPTH / OCTREE_MIN_HALF).
 *
 * Coincident positions are reachable through the public layout API: layout3d
 * anchors each node by fnv1a(file cluster key) and jitters it with a PRNG
 * seeded by fnv1a(qualified_name). The three QNs below are distinct strings
 * with IDENTICAL 32-bit FNV-1a hashes (0x06bb012e, found by offline brute
 * force), so in the same file they get bit-identical positions on every
 * platform (integer hashing only — no libm in the coincidence path).
 *
 * A literal sub-ULP-separated pair cannot be constructed through the public
 * API: same-anchor positions are quantized to exact multiples of the jitter
 * quantum (5/4096 — exactly 20 ULP at anchor magnitude ~600), and
 * cross-anchor separations depend on the platform's cosf/sinf bits. Exact
 * coincidence is the API-reachable degenerate input, and it necessarily
 * drives the recursion through the sub-ULP regime: half_size falls below
 * ULP(center) with the bodies still unseparated, freezing child centers
 * while cells keep being allocated.
 */
#if !defined(_WIN32)
/* Child body: builds the store and runs the layout so a crash or hang cannot
 * take down the runner (alarm bounds a hang, fork isolates a SIGSEGV).
 * Deliberately NO memory rlimit: under a rlimit a failing calloc makes
 * octree_insert silently truncate and the UNFIXED code would complete —
 * turning this guard vacuously green. The alarm alone bounds the runaway.
 * Exit codes: 0 ok, 2 store setup, 3 layout NULL, 4 node count/lookup,
 * 5 fixture no longer coincident, 6 non-finite coordinate. Never returns. */
static void layout_octree_guard_child(void) {
    alarm(5); /* post-fix the whole child runs in milliseconds */
    cbm_store_t *store = cbm_store_open_memory();
    if (!store)
        _exit(2);
    if (cbm_store_upsert_project(store, "test", "/tmp/test") != CBM_STORE_OK)
        _exit(2);

    /* Distinct QNs, one fnv1a hash — coincident after anchor + jitter. */
    static const char *cqn[3] = {"test::octree_c5988474", "test::octree_c11394919",
                                 "test::octree_c33141700"};
    for (int i = 0; i < 3; i++) {
        char name[32];
        snprintf(name, sizeof(name), "co%d", i);
        cbm_node_t n = {.project = "test",
                        .label = "Function",
                        .name = name,
                        .qualified_name = cqn[i],
                        .file_path = "pkg/sub/mod/a.c",
                        .start_line = i + 1,
                        .end_line = i + 2};
        if (cbm_store_upsert_node(store, &n) <= 0)
            _exit(2);
    }
    /* A few normally-spread nodes so the octree root box has realistic
     * (non-degenerate) extent, as in the reported repositories. */
    for (int i = 0; i < 3; i++) {
        char name[32], qn[64], fp[32];
        snprintf(name, sizeof(name), "fn%d", i);
        snprintf(qn, sizeof(qn), "test::spread_fn%d", i);
        snprintf(fp, sizeof(fp), "dir%d/f%d.c", i, i);
        cbm_node_t n = {.project = "test",
                        .label = "Function",
                        .name = name,
                        .qualified_name = qn,
                        .file_path = fp,
                        .start_line = 1,
                        .end_line = 2};
        if (cbm_store_upsert_node(store, &n) <= 0)
            _exit(2);
    }

    cbm_layout_result_t *r = cbm_layout_compute(store, "test", CBM_LAYOUT_OVERVIEW, NULL, 0, 100);
    if (!r)
        _exit(3);
    if (r->node_count != 6)
        _exit(4);

    /* The colliding QNs must actually be coincident — identical output
     * coordinates (identical seeds → identical positions, and coincident
     * bodies receive identical forces every iteration, so they stay
     * together). If a seeding change ever breaks this, the fixture no longer
     * reproduces the bug: fail loudly instead of going vacuously green. */
    int ci[3], nc = 0;
    for (int i = 0; i < r->node_count && nc < 3; i++) {
        if (r->nodes[i].qualified_name &&
            strncmp(r->nodes[i].qualified_name, "test::octree_c", 14) == 0)
            ci[nc++] = i;
    }
    if (nc != 3)
        _exit(4);
    for (int k = 1; k < 3; k++) {
        if (r->nodes[ci[k]].x != r->nodes[ci[0]].x || r->nodes[ci[k]].y != r->nodes[ci[0]].y ||
            r->nodes[ci[k]].z != r->nodes[ci[0]].z)
            _exit(5);
    }
    for (int i = 0; i < r->node_count; i++) {
        if (!isfinite(r->nodes[i].x) || !isfinite(r->nodes[i].y) || !isfinite(r->nodes[i].z))
            _exit(6);
    }

    cbm_layout_free(r);
    cbm_store_close(store);
    _exit(0);
}
#endif

TEST(layout_coincident_nodes_bounded) {
#if defined(_WIN32)
    SKIP_PLATFORM("fork/alarm not available; POSIX-only bounded-hang reproduction");
#else
    fflush(NULL);
    pid_t pid = fork();
    if (pid < 0)
        FAIL("fork() failed");
    if (pid == 0)
        layout_octree_guard_child(); /* never returns */

    int status = 0;
    (void)waitpid(pid, &status, 0);

    /* Unfixed code dies here: SIGSEGV (unbounded recursion overflowing the
     * stack) or SIGALRM (tail-call-optimized allocation runaway cut off by
     * the child's alarm). Fixed code exits 0 well within the budget. */
    ASSERT_FALSE(WIFSIGNALED(status));
    ASSERT_TRUE(WIFEXITED(status));
    ASSERT_EQ(WEXITSTATUS(status), 0);
    PASS();
#endif
}

/* ── Suite ────────────────────────────────────────────────────── */

SUITE(ui) {
    /* Config */
    RUN_TEST(config_load_defaults);
    RUN_TEST(config_save_and_reload);
    RUN_TEST(config_overwrite);
    RUN_TEST(config_corrupt_file);
    RUN_TEST(config_missing_fields);

    /* Embedded assets (stub) */
    RUN_TEST(embedded_lookup_not_found);
    RUN_TEST(embedded_stub_count);

    /* Layout engine */
    RUN_TEST(layout_empty_graph);
    RUN_TEST(layout_single_node);
    RUN_TEST(layout_two_connected);
    RUN_TEST(layout_respects_max_nodes);
    RUN_TEST(layout_clamps_render_cap_from_env);
    RUN_TEST(layout_env_zero_uncaps);
    RUN_TEST(layout_garbage_env_falls_back_to_default_cap);
    RUN_TEST(layout_call_depth_chain);
    RUN_TEST(layout_call_depth_diamond_and_unreached);
    RUN_TEST(layout_call_depth_no_entry_labels);
    RUN_TEST(layout_call_depth_large_chain_fast);
    RUN_TEST(layout_deterministic);
    RUN_TEST(layout_to_json);
    RUN_TEST(layout_to_binary_roundtrip);
    RUN_TEST(layout_to_binary_empty);
    RUN_TEST(layout_overview_filters_low_degree);
    RUN_TEST(layout_overview_fallback_when_no_hubs);
    RUN_TEST(layout_null_inputs);

    /* /api/layout.bin blob cache + ETag */
    RUN_TEST(layout_bin_etag_and_cache);
    RUN_TEST(layout_dead_code_classification);
    RUN_TEST(layout_coincident_nodes_bounded);
}
