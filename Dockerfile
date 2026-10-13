# ── Stage 1: Bundle frontend JS & WASM ──
FROM node:22-slim AS js-builder

WORKDIR /src

COPY package.json package-lock.json* ./
RUN if [ -f package-lock.json ]; then npm ci; else npm install; fi

COPY tino/static/js tino/static/js
RUN npm run build


# ── Stage 2: Fetch vendor CSS & build Python wheel ──
FROM python:3.14-slim AS py-builder

ARG SETUPTOOLS_SCM_PRETEND_VERSION_FOR_TINO

WORKDIR /src

RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates git \
    && rm -rf /var/lib/apt/lists/* \
    && pip install --no-cache-dir build

COPY pyproject.toml README* LICENSE* ./
COPY .git .git
COPY tino tino
COPY --from=js-builder /src/tino/static/js/vendor tino/static/js/vendor
COPY --from=js-builder /src/tino/static/wasm tino/static/wasm

RUN mkdir -p tino/static/css/vendor \
    && curl -sSfLo tino/static/css/vendor/colours.css https://assets.confirm.ch/colours.css \
    && python3 -m build --wheel -o /dist

    
# ── Stage 3: Slim runtime image ──
FROM python:3.14-slim

# renovate: github-releases depName=typst/typst
ARG TYPST_VERSION=0.15.1

# renovate: github-releases depName=Myriad-Dreamin/tinymist
ARG TINYMIST_VERSION=0.15.12

# Used for the DOCX export; only published for amd64 & arm64, so other
# platforms ship without it and the export is hidden in the UI.
# renovate: github-releases depName=jgm/pandoc
ARG PANDOC_VERSION=3.12.1

# Populated automatically by BuildKit/buildx from the target platform.
ARG TARGETARCH
ARG TARGETVARIANT

WORKDIR /usr/src

COPY --from=py-builder /dist/*.whl .
COPY tino/gitattributes /etc/gitattributes

RUN apt-get update && apt-get install -y --no-install-recommends curl git git-lfs xz-utils \
    && pip install --no-cache-dir *.whl \
    && rm -f *.whl \
    && case "$TARGETARCH/$TARGETVARIANT" in \
         amd64/*)   TYPST_TARGET=x86_64-unknown-linux-musl ;; \
         arm64/*)   TYPST_TARGET=aarch64-unknown-linux-musl ;; \
         arm/v7)    TYPST_TARGET=armv7-unknown-linux-musleabi ;; \
         riscv64/*) TYPST_TARGET=riscv64gc-unknown-linux-gnu ;; \
         *) echo "No Typst binary for target platform: '${TARGETARCH}/${TARGETVARIANT}'" >&2; exit 1 ;; \
       esac \
    && curl -sSfL https://github.com/typst/typst/releases/download/v${TYPST_VERSION}/typst-${TYPST_TARGET}.tar.xz \
       | tar -xJ --strip-components=1 -C /usr/local/bin typst-${TYPST_TARGET}/typst \
    && case "$TARGETARCH/$TARGETVARIANT" in \
         amd64/*) TINYMIST_TARGET=x86_64-unknown-linux-gnu ;; \
         arm64/*) TINYMIST_TARGET=aarch64-unknown-linux-gnu ;; \
         arm/v7)  TINYMIST_TARGET=armv7-unknown-linux-gnueabihf ;; \
         *)       TINYMIST_TARGET="" ;; \
       esac \
    && if [ -n "$TINYMIST_TARGET" ]; then \
         curl -sSfL https://github.com/Myriad-Dreamin/tinymist/releases/download/v${TINYMIST_VERSION}/tinymist-${TINYMIST_TARGET}.tar.gz \
           | tar -xz --strip-components=1 -C /usr/local/bin tinymist-${TINYMIST_TARGET}/tinymist; \
       else \
         echo "No Tinymist binary for target platform '${TARGETARCH}/${TARGETVARIANT}', falling back to Typst CLI" >&2; \
       fi \
    && case "$TARGETARCH" in \
         amd64|arm64) curl -sSfL https://github.com/jgm/pandoc/releases/download/${PANDOC_VERSION}/pandoc-${PANDOC_VERSION}-linux-${TARGETARCH}.tar.gz \
                        | tar -xz --strip-components=2 -C /usr/local/bin pandoc-${PANDOC_VERSION}/bin/pandoc ;; \
         *) echo "No pandoc binary for target platform '${TARGETARCH}', DOCX export disabled" >&2 ;; \
       esac \
    && git lfs install --system \
    && git config --system core.attributesFile /etc/gitattributes \
    && apt-get purge -y --auto-remove xz-utils \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd -r -g 1234 tino \
    && useradd -r -u 1234 -g 1234 -d /tino -m tino \
    && mkdir -p /data \
    && chown tino: /data

USER tino

WORKDIR /tino

VOLUME /data

ENV TINO_DATA_DIR=/data
ENV XDG_CACHE_HOME=/tmp/.cache

EXPOSE 5000

HEALTHCHECK --start-period=10s --start-interval=2s --interval=10s --timeout=10s --retries=3 \
    CMD curl -sfL http://127.0.0.1:5000/health

ENTRYPOINT ["gunicorn"]
CMD ["-k", "uvicorn.workers.UvicornWorker", "-w", "1", "-b", "0.0.0.0:5000", "--worker-tmp-dir", "/tmp", "--chdir", "/tmp", "tino:create_app()"]