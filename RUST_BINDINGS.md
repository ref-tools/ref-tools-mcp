Rust-backed SearchDB bindings

Overview
- The BM25 + cosine KNN parts of `searchdb.ts` are reimplemented in Rust under `native/searchdb-rs` and exposed to Node via N-API.
- A small TypeScript wrapper `searchdb_rust.ts` mirrors the `SearchDB` API and delegates indexing/search to the native module while keeping annotators and relevance filters in TS.

Build Prerequisites
- Rust toolchain (stable). Install: https://rustup.rs
- Node.js 18+ (N-API v8 or newer).

Quick Build
1) Build the Rust crate
   - Linux/macOS: `cargo build -p searchdb_native --release --manifest-path native/searchdb-rs/Cargo.toml`
   - Windows (PowerShell): `cargo build -p searchdb_native --release --manifest-path native/searchdb-rs/Cargo.toml`

2) Copy/rename the compiled library to a `.node` file the TS loader can find:
   - Linux: `cp native/searchdb-rs/target/release/libsearchdb_native.so native/searchdb_native.node`
   - macOS: `cp native/searchdb-rs/target/release/libsearchdb_native.dylib native/searchdb_native.node`
   - Windows: `copy native\searchdb-rs\target\release\searchdb_native.dll native\searchdb_native.node`

   The wrapper tries multiple locations; you can also place the file at `native/index.node` instead.

Optional: Use @napi-rs/cli
- For a one-step build that outputs a `.node` file, install the CLI: `npm i -D @napi-rs/cli`
- Build: `npx napi build --cargo-cwd native/searchdb-rs --release`
- Then copy the generated `.node` artifact (printed by the CLI) into `native/index.node` or `native/searchdb_native.node`.

Using the Rust Engine
- Programmatic (SearchAgent): pass `searchEngine: 'rust'` in `SearchAgentOptions`.
- CLI benchmark: already updated to use the Rust engine by default.

Troubleshooting
- If `searchdb_rust.ts` cannot find the native module, ensure the `.node` file exists at one of:
  - `native/index.node`
  - `native/searchdb_native.node`
  - `native/searchdb-rs/target/release/searchdb_native.node` (if you placed it there)
- On macOS, you may need `export MACOSX_DEPLOYMENT_TARGET=$(sw_vers -productVersion | cut -d. -f1-2)` before building.

