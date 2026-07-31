FROM node:24.18.0-bookworm-slim

ARG PNPM_VERSION=11.11.0
ARG RUST_VERSION=1.97.1
ARG RUST_TARGET=x86_64-unknown-linux-gnu

ENV CARGO_HOME=/usr/local/cargo \
    RUSTUP_HOME=/usr/local/rustup \
    RUSTUP_TOOLCHAIN=${RUST_VERSION} \
    PATH=/usr/local/cargo/bin:${PATH}

RUN apt-get update \
    && apt-get install --yes --no-install-recommends \
      build-essential \
      ca-certificates \
      clang \
      curl \
      git \
      pkg-config \
      python3 \
    && rm -rf /var/lib/apt/lists/* \
    && npm install --global "pnpm@${PNPM_VERSION}" \
    && curl --proto '=https' --tlsv1.2 --silent --show-error --fail https://sh.rustup.rs \
      | sh -s -- -y --profile minimal --default-toolchain "${RUST_VERSION}" --target "${RUST_TARGET}" \
    && node --version \
    && pnpm --version \
    && rustc --version \
    && rustc -vV | grep "host: ${RUST_TARGET}"

WORKDIR /workspace

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY crates/irregular-nesting-native/package.json crates/irregular-nesting-native/package.json
RUN pnpm install --frozen-lockfile --ignore-scripts

COPY . .
RUN pnpm build:native

ENTRYPOINT ["pnpm", "exec", "tsx", "--tsconfig", "tsconfig.node.json", "scripts/rust-parity/measure-p5-aggregate.ts"]
