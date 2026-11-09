# Immutable upstream digest verified in GitHub Actions run 42658493169.
FROM ghcr.io/hamsanders/soundbox:v0.4.1@sha256:b7e3cfba2a3b420179ebe68964cd1b951e145aa3b61bfb0f2e6fc5ee9c9c6fc8
COPY deploy/railway/soundbox/gateway.mjs deploy/railway/soundbox/run.mjs /opt/clipsflow-gateway/
ENV PORT=8080 SOUNDBOX_LOG_LEVEL=warning SOUNDBOX_AUDIOCPP_BACKEND=cpu
# Raw Soundbox binds loopback only; only this bearer-authenticated facade listens
# on the Railway network. Expose NO public domain for this service.
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --retries=3 CMD curl -fsS http://127.0.0.1:8080/healthz >/dev/null || exit 1
ENTRYPOINT ["node","/opt/clipsflow-gateway/run.mjs"]
CMD []
