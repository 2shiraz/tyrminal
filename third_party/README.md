# Third-party licences

Tyrminal is licensed under the terms in [LICENSE](../LICENSE). It is built from open-source
components with their own licences:

- **Rust crates and npm packages.** Every release attaches software bills of materials
  (`tyrminal-<tag>-sbom.tar.gz`, CycloneDX) listing each component, its version and its licence.
  Only the licences allowed in [deny.toml](../deny.toml) can enter the build; CI enforces this.
- **Fonts bundled with the app** (in `apps/desktop/public/fonts/`):
  - JetBrains Mono, SIL Open Font License 1.1 ([JetBrainsMono-OFL.txt](../apps/desktop/public/fonts/JetBrainsMono-OFL.txt))
  - Symbols Nerd Font Mono, MIT ([SymbolsNerdFont-LICENSE.txt](../apps/desktop/public/fonts/SymbolsNerdFont-LICENSE.txt))

Settings → About in the app links here.
