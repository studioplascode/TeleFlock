# Build environment for the Linux release packages (scripts/build-linux.sh): Ubuntu 22.04, the
# oldest supported LTS with webkit2gtk-4.1. Its glibc 2.35 is the floor the .deb and the
# AppImage need, so they run on Debian 12+, Ubuntu 22.04+ and other distros of that age or newer
# (a build on a newer host would pull in newer glibc symbols, e.g. C23 `__isoc23_strtol`).
# Same packages as .github/workflows/linux.yml.
FROM ubuntu:22.04

ARG DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
      libwebkit2gtk-4.1-dev libayatana-appindicator3-dev librsvg2-dev libxdo-dev libssl-dev \
      build-essential pkg-config curl wget file patchelf ca-certificates unzip git xdg-utils \
    && rm -rf /var/lib/apt/lists/*

# Same Rust and Bun as the release box (build-linux.sh passes the host's versions).
ARG RUST_VERSION=stable
ARG BUN_VERSION=latest
ENV RUSTUP_HOME=/opt/rustup CARGO_HOME=/opt/cargo PATH=/opt/cargo/bin:/opt/bun/bin:$PATH
RUN curl -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal --default-toolchain "$RUST_VERSION" \
    && rustc --version
RUN if [ "$BUN_VERSION" = latest ]; then curl -fsSL https://bun.sh/install | BUN_INSTALL=/opt/bun bash; \
    else curl -fsSL https://bun.sh/install | BUN_INSTALL=/opt/bun bash -s "bun-v$BUN_VERSION"; fi \
    && bun --version
