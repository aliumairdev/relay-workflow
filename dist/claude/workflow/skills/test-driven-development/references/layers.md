# Coverage by layer

- **Backend:** model rules, calculations, state transitions, constraints, jobs, recovery.
- **APIs:** authentication, tenant scope, permitted input, status and body, error contract, replay handling.
- **Frontend:** user journeys, forms and errors, navigation, partial updates, focus, denied/pending/unknown states.
- **Integrations:** signed ingress, payload contracts, partial errors, retries, timeout after effect, verified results.
- **Data and operations:** real migrations, grants, outbox/crash behaviour, assets, safe recovery.

A model test cannot replace a request test; a request test cannot prove a browser interaction. Test real database constraints and concurrency with the correct roles and connections. Avoid tests of line counts, exact class lists or private details.
