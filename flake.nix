{
  description = "Node 24 + pnpm 11 + Rust dev shell";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/master";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = { self, nixpkgs, flake-utils }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs = import nixpkgs { inherit system; };
        nodejs = pkgs.nodejs_24;
        pnpm = pkgs.pnpm_11.override { inherit nodejs; };
        tools = with pkgs; [ git nixfmt nodejs pnpm typescript ];
        # Native toolchain for the napi-rs irregular nesting addon:
        # rustc/cargo plus rustfmt, clippy, and rust-analyzer. mkShell's
        # stdenv already provides the C compiler and linker the cdylib
        # build needs.
        rustTools = with pkgs; [ rustc cargo rustfmt clippy rust-analyzer ];
      in {
        devShells.default = pkgs.mkShell {
          packages = tools ++ rustTools;
        };
      });
}
