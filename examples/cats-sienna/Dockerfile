# CATS + Sienna demo data for GridSight.
#
#   docker build -t gridsight-cats-sienna examples/cats-sienna
#   docker run --rm -v gridsight-cats-data:/data -v "$PWD/cats-output:/output" gridsight-cats-sienna
#
# /data caches the CATS repo and the 2019 profiles (about 600 MB) between
# runs; /output gets system.json, simulation_store.h5 and the bus coordinates.
# See README.md for options and how to load the result into GridSight.

ARG JULIA_VERSION=1.11
FROM julia:${JULIA_VERSION}-bookworm

RUN apt-get update && apt-get install -y --no-install-recommends \
        ca-certificates git python3 python3-venv \
    && rm -rf /var/lib/apt/lists/* \
    && python3 -m venv /opt/gdown \
    && /opt/gdown/bin/pip install --no-cache-dir "gdown==5.2.0"
ENV PATH="/opt/gdown/bin:${PATH}"

# libgit2's bundled CA store fails behind TLS-intercepting proxies;
# CLI git uses the OS store.
ENV JULIA_PKG_USE_CLI_GIT=true

WORKDIR /work
COPY Project.toml Manifest.toml ./
RUN julia --project=. -e 'using Pkg; Pkg.instantiate(); Pkg.precompile()'

COPY fetch_data.sh run.sh build_system.jl run_ed.jl ./

VOLUME ["/data", "/output"]
CMD ["bash", "/work/run.sh"]
