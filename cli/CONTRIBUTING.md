# Setup

0. Clone, and then run `git submodule update --init --recursive`
1. Get the extensions: [rust-analyzer](https://marketplace.visualstudio.com/items?itemName=rust-lang.rust-analyzer) and [CodeLLDB](https://marketplace.visualstudio.com/items?itemName=vadimcn.vscode-lldb)
2. Ensure your workspace is set to the `launcher` folder being the root.

## Building the CLI on Windows

OpenSSL is needed for the key exchange the tunnel client does. This tree does not ask you to install
it: `Cargo.toml` enables `vendored-openssl` on `tunnels`, so `openssl-sys` compiles and links a
private copy. The one thing that must be installed is **Perl**, which OpenSSL's own `Configure`
script is written in:

1. Install [Strawberry Perl](https://strawberryperl.com/) (the portable ZIP works: extract it
   anywhere and point `PICODE_PERL` at its `bin` directory, or put it on `PATH`).
2. `cargo build --release` then works without a system OpenSSL.

Git for Windows also ships a Perl, but it is a stripped build that cannot load
`Locale::Maketext::Simple`, and OpenSSL's configure stops on exactly that; `build/build-cli.sh`
checks for the module before using a Perl it finds.

For reference, OpenSSL is needed for the key exchange done when forwarding Basis tunnels. When all
interested Basis clients support ED25519, it would be possible to use libsodium only.

# Debug

1. You can use the Debug tasks already configured to run the launcher.
