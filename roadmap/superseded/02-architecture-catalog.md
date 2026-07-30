---
id: F002
title: Local app and high-level architecture catalog
milestone: M1-architecture-catalog
status: ready
depends_on: [F001]
---

# F002 — Local app and high-level architecture catalog

## Goal

A user can open a loopback-only web application, browse the architecture as a hierarchy, and
create, edit, or safely delete high-level architecture elements. Changes persist as small YAML
diffs.

## User story

As a developer or architect, I want to manage the system catalog through a focused UI so that I do
not need to hand-edit YAML for normal changes, while the files remain the source of truth.

## Scope

### In

- add the Hono local server and Vite/React app;
- implement:

  ```bash
  veriflow open [path] [--port 4747] [--no-browser]
  ```

- bind only to `127.0.0.1`;
- serve the SPA and `GET /api/project`, `GET /api/architecture`;
- show an application shell with:
  - project name;
  - validation status;
  - Architecture navigation enabled;
  - Documentation and Specifications visible but labelled `Later`;
- show elements as a searchable catalog and containment tree;
- show an element inspector with kind, parent, name, description, technology, status, tags, and
  documentation paths;
- create and edit elements with server-side validation;
- delete an element only when it has no children and no relationships;
- use model revisions on every mutation and return a conflict instead of overwriting an external
  change;
- preserve array order and unrelated YAML values during supported edits;
- re-read the model when the browser gains focus or the user presses Refresh;
- show validation, conflict, and file-write failures without losing unsaved form values.

### Out

- graphical architecture diagram;
- relationship creation/editing;
- automatic file watching or multi-browser live updates;
- Markdown rendering or document search;
- specification/test management;
- authentication, LAN binding, or remote access;
- drag-and-drop hierarchy editing;
- undo history beyond normal Git/file recovery;
- source files, symbols, and analyzer data.

## Primary screen

```text
┌──────────────────────────────────────────────────────────────┐
│ VeriFlow · Shop                         Valid · Refresh      │
├──────────────┬───────────────────────────┬───────────────────┤
│ Architecture │ Search architecture...    │ Web application   │
│ Docs (later) │                           │                   │
│ Specs (later)│ Shop                      │ Application/service│
│              │ ├─ Web application        │ Parent: Shop      │
│              │ │  └─ Checkout            │ React             │
│              │ ├─ Orders API             │                   │
│              │ └─ Database               │ Customer UI...    │
│              │                           │                   │
│              │ External systems          │ [Edit] [Delete]   │
│              │ └─ Payment provider       │                   │
└──────────────┴───────────────────────────┴───────────────────┘
```

No architecture graph is required in this feature. The hierarchy is the usable first
representation.

## HTTP contract

```text
GET    /api/project
GET    /api/architecture
POST   /api/architecture/elements
PUT    /api/architecture/elements/:id
DELETE /api/architecture/elements/:id
```

Mutation request example:

```json
{
  "expectedRevision": "sha256:...",
  "element": {
    "id": "shop-web",
    "kind": "container",
    "parentId": "shop",
    "name": "Web application",
    "description": "Browser user interface.",
    "technology": "React",
    "status": "active",
    "tags": ["frontend"],
    "documentation": []
  }
}
```

Response returns `{ model, revision }`. API error bodies use a shared versioned error contract:

```json
{
  "contractVersion": 1,
  "error": {
    "code": "architecture.revision_conflict",
    "message": "The architecture file changed outside VeriFlow.",
    "diagnostics": []
  }
}
```

## Interaction rules

- ID is proposed from the name but remains explicitly editable until first save.
- Changing a persisted ID is not supported in F002; the user creates a replacement instead.
- Parent options are filtered to valid kinds and exclude descendants.
- Delete explains exactly which child or relationship blocks it.
- Deprecated elements remain visible with a badge and can be filtered out.
- Search matches ID, name, description, technology, and tags locally at V0 scale.
- Documentation paths are plain validated references in this feature; opening/rendering them is
  deferred.
- A successful save updates the displayed revision and clears the dirty form.
- On HTTP `409`, the user can copy their draft, reload the new model, and reapply it. Automatic merge
  is out of scope.

## Design constraints

- UI components do not know YAML paths or use filesystem APIs;
- the server receives one immutable repository root at startup;
- server startup validates the workspace and refuses to serve an invalid model, while showing the
  CLI command and diagnostics needed to repair it;
- browser opening happens only after the server is listening;
- if the requested port is occupied, report the process-independent problem and suggest `--port`;
- no CDN fonts, telemetry scripts, update checks, or runtime web dependencies;
- all durable mutations pass through `ArchitectureService`;
- write integration tests use isolated temporary repositories;
- UI is keyboard usable and form fields have labels and errors.

## Acceptance criteria

- [ ] `veriflow open` starts on loopback and opens the correct URL after the server is ready.
- [ ] The generated F001 workspace renders its root system in the catalog.
- [ ] Create system/container/module/data-store/external-system elements and see correct hierarchy.
- [ ] Editing one description produces a focused YAML diff and survives server restart.
- [ ] Duplicate ID, invalid parent, and empty description are rejected consistently in UI and API.
- [ ] Deleting an element with a child is blocked; deleting an unreferenced leaf succeeds after
      confirmation.
- [ ] An external edit after the form loads causes `409` and is never overwritten.
- [ ] Refresh/focus loads a valid external edit.
- [ ] Server listens on `127.0.0.1`, makes no outgoing requests, and stores no secrets.
- [ ] The default screen contains no file or function nodes.
- [ ] Unit, API integration, and Playwright smoke tests pass.

## Automated test cases

At minimum:

1. loopback binding and occupied port;
2. invalid workspace startup;
3. list generated root;
4. create each supported element kind;
5. update all editable fields;
6. invalid containment;
7. blocked and successful delete;
8. stale revision conflict;
9. atomic-write failure shown as non-destructive error;
10. browser smoke: create, edit, reload, delete.

## Manual verification flow

| # | Action | Expected result |
|---|---|---|
| 1 | Run `veriflow open --no-browser`, then open the printed URL. | App shows the correct repository and one root system. |
| 2 | Add Web application under the system and Checkout under Web. | Tree and inspector show the hierarchy; YAML contains both. |
| 3 | Edit Checkout description and tags. | UI updates; Git diff changes only the relevant values. |
| 4 | Try to delete Web application. | Deletion is blocked and names child Checkout. |
| 5 | Open Checkout edit form, change its YAML description externally, then save the form. | Conflict is shown; external value remains on disk; form draft is retained. |
| 6 | Refresh, deprecate Checkout, and restart VeriFlow. | Deprecated state persists and is visibly labelled. |

## Definition of done

The catalog is a useful editor without the map, all writes are conflict-safe, and F003 can add
relationships through the same service and revision contracts.
