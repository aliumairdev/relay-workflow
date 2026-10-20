# Dependency cleanup

Inspect the manifests, lockfiles, import maps, initialisers, assets and bin scripts. Do not assume extra manifests exist. Check indirect dependencies and framework hooks before removing anything.

Use official sources for current support, maintenance, security, licence and compatibility. Do not silently replace prerelease or Git dependencies. Remove only proven-unused dependencies in scope; regenerate lockfiles with the package manager. Verify production asset resolution, then run affected tests, style checks and the dependency audit.
