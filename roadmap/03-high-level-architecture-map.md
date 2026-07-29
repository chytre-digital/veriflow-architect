---
id: F003
title: High-level architecture map and declared relationships
milestone: M2-architecture-map
status: ready
depends_on: [F002]
---

# F003 — High-level architecture map and declared relationships

## Goal

A user can declare intentional relationships and understand the system through a stable,
progressively disclosed architecture diagram that never falls back to a source-code call graph.

## User story

As a developer or architect, I want to see systems, applications, modules, data stores, and external
dependencies at the appropriate level so that I can orient myself before reading code.

## Scope

### In

- relationship create, edit, and delete through `ArchitectureService`, HTTP API, and UI;
- relation fields: ID, source, target, kind, description, optional technology, and tags;
- a Map/Catalog view toggle under Architecture;
- deterministic ELK layout rendered with React Flow;
- progressive scopes:
  - **Landscape/context view:** root systems, people, external systems, and relationships declared
    between those visible elements;
  - **System/application view:** direct containers/data stores of a selected system, plus related
    people/external systems and relationships declared between those visible elements;
  - **Module view:** direct modules of a selected container/module plus relationships declared
    between those visible elements;
- breadcrumb navigation between scopes;
- node inspector reusing the F002 element details;
- edge inspector with relationship details and edit/delete actions;
- filters for lifecycle status and tags;
- an empty-state explanation when a scope has no declared relationships;
- validation and revision-conflict behavior identical to element editing;
- URL state for selected scope and selected node/edge, so browser Back works.

### Out

- imports, symbols, function calls, execution flows, or analyzer-generated edges;
- automatic relationship inference;
- aggregated descendant relationships;
- architecture health, cycle warnings, boundary violations, or scoring;
- free-form/manual node positioning;
- persisted viewport coordinates;
- diagram export;
- multiple saved views;
- collaborative cursors or live multi-user editing;
- documentation or test overlays.

## Map behavior

Default system/application view after the demo model is populated:

```text
System: Shop

 [Customer]
      │ uses
      ▼
 [Web application] ──HTTPS──▶ [Orders API] ──SQL──▶ [Database]
                                  │
                                  │ HTTPS
                                  ▼
                           [Payment provider]
```

The map displays only model entities. It must never scan a source directory to populate nodes or
edges.

### Progressive disclosure

- opening Architecture Map selects the first root system and shows its system/application view;
- the first breadcrumb opens the landscape/context view;
- entering a system changes to its application view;
- entering a container changes to its module view;
- breadcrumb items restore the previous scope;
- external systems related directly to visible elements may appear at the edge of the scope;
- unrelated external systems do not appear;
- cross-scope relationships are listed in the selected node inspector even when their other
  endpoint is not drawn, with an `Outside this view` label.

### Layout stability

ELK input is sorted by stable element and relationship IDs. Layout configuration is fixed and
versioned in code. Given the same visible model and viewport class, node coordinates must be
identical across refreshes.

Adding one unrelated element should not reorder model arrays. Perfect geometric stability after a
graph change is not required, but identical input must never produce a visibly random layout.

## Relationship interaction

Create Relationship is a form, not a drag gesture:

```text
From          Orders API
Relationship  uses
To            Payment provider
Description   Creates and confirms payment intents.
Technology    HTTPS
Tags          checkout, payments
```

This keeps the architectural statement explicit. Optional edge-drag creation is deferred.

Relationship IDs are proposed as `<source>-<kind>-<target>` with a numeric suffix on collision.
Like element IDs, a persisted relationship ID is immutable in F003.

## API additions

```text
POST   /api/architecture/relationships
PUT    /api/architecture/relationships/:id
DELETE /api/architecture/relationships/:id
```

All mutations include `expectedRevision` and return the complete updated model and new revision.

## Visual rules

- shapes or icons distinguish people, systems, applications/services, modules, data stores, and
  external systems without relying only on color;
- deprecated elements and relationships are muted but readable;
- relationship label prioritizes description; technology/protocol is secondary;
- parallel relationships remain individually selectable;
- direction is always visible;
- graph controls support fit-to-view, zoom, and reset;
- Catalog remains available as the accessible non-diagram representation;
- no numeric “health” score appears because V0 has no evidence model for one.

## Design constraints

- layout is a pure function of the visible architecture model and scope;
- React Flow/ELK types stay in `apps/web`; domain packages remain renderer-independent;
- graph filtering never mutates the underlying model;
- element and relationship validation is server-authoritative;
- the model is useful without JavaScript rendering because YAML remains canonical and the Catalog
  remains the text representation;
- loading a 100-element / 200-relationship high-level fixture should render interactively on a
  normal development laptop; optimizing thousands of nodes is explicitly unnecessary.

## Acceptance criteria

- [ ] Create, edit, and delete every supported relationship kind; changes persist to readable YAML.
- [ ] Invalid endpoints, self-relationships, duplicate IDs, empty descriptions, and stale revisions
      are rejected without data loss.
- [ ] The same model and scope produce stable positions across refresh and restart.
- [ ] System, application, and module scopes show only the elements allowed by the disclosure rules.
- [ ] Breadcrumb and browser Back navigation restore the previous scope.
- [ ] Selecting a node or edge opens the correct inspector and has a shareable local URL.
- [ ] A relationship to an element outside the current scope is still discoverable in the node
      inspector.
- [ ] Filters change only the view and never rewrite YAML.
- [ ] The 100-node/200-edge fixture remains usable and the default demo map contains no files or
      functions.
- [ ] Playwright covers the architecture-first acceptance demo through relationship creation and
      drill-down.

## Automated test cases

At minimum:

1. relationship schema and all kinds;
2. create/update/delete API paths;
3. endpoint, self-edge, and revision failures;
4. scope projection for context/application/module views;
5. outside-scope relationship listing;
6. deterministic layout snapshot for identical input;
7. node/edge selection URL state;
8. filter non-persistence;
9. 100-node/200-edge render smoke;
10. full demo map browser path.

## Manual verification flow

| # | Action | Expected result |
|---|---|---|
| 1 | In the catalog, create Customer, Web, Orders API, Database, and Payment provider. | Elements have the intended parents and kinds. |
| 2 | Add four described relationships using the form. | YAML contains explicit, readable relationships. |
| 3 | Open Map at the Shop system. | System/application view is uncluttered and uses deterministic layout. |
| 4 | Enter Shop, then Orders API. | Application then module scope opens; breadcrumbs and Back restore prior scope. |
| 5 | Select the Orders API → Payment provider edge. | Inspector shows direction, description, HTTPS, and tags. |
| 6 | Refresh and restart the process. | Diagram positions and selected URL scope remain stable. |
| 7 | Filter out deprecated elements and run `git diff`. | View changes, but no file is written. |
| 8 | Inspect the map carefully. | No source file, class, function, import, or inferred call appears. |

## Definition of done

The architecture-first acceptance demo passes, the diagram remains a human-scale declared model,
and later documentation and specification features can link to stable element IDs without changing
the architecture storage contract.
