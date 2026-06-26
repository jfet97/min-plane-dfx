{
  description = "Node 24 + pnpm 11 dev shell";

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
      in {
        devShells.default = pkgs.mkShell {
          packages = tools;
        };
      });
}
