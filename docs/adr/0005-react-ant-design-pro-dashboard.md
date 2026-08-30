# ADR 0005: Build the Dashboard with React and Ant Design Pro

- Status: Accepted
- Date: 2026-08-30

## Context

The dashboard is an operations console centered on dense task tables, filters, worker health, run timelines, findings, approvals, retries, and logs. A complete enterprise administration framework is more valuable than a general-purpose component toolkit.

## Decision

Use React 19, TypeScript, Ant Design Pro v6, Umi Max 4, Ant Design 6, and Pro Components for the dashboard.

Use the full Ant Design Pro application model, including `ProLayout`, routing, access control, localization, themes, `ProTable`, `ProForm`, and `ProDescriptions`. Generate the API client from the Server OpenAPI contract. Use TanStack Query for Server state and TanStack Virtual for long log views.

The default experience is a work-oriented operations console, not the Ant Design Pro Analysis demo. Remove sample analytics, mock business pages, and unused charting dependencies. The main navigation covers work items, jobs, workers, approvals, publications, and system health.

Pin exact frontend versions and commit the lockfile, especially where Pro Components uses a prerelease line. Wrap heavily used Pro components behind small project-owned components. The production build is served as static assets by the Server.

## Consequences

- The dashboard gains mature enterprise tables, forms, layout, access, and localization patterns.
- The project adopts Ant Design rather than Material Design as its visual and interaction system.
- Umi Max conventions become part of the frontend architecture.
- Long logs require a specialized virtualized viewer instead of `ProTable`.
- Version upgrades require focused UI and end-to-end regression testing.

