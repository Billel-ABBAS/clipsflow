# Versioned upstream; record/pin its registry digest after the image validation.
FROM ghcr.io/hamsanders/soundbox:v0.4.1
COPY deploy/railway/soundbox/gateway.mjs deploy/railway/soundbox/run.mjs /opt/clipsflow-gateway/
ENV PORT=8080 SOUNDBOX_LOG_LEVEL=warning SOUNDBOX_AUDIOCPP_BACKEND=cpu
# Raw Soundbox binds loopback only; only this bearer-authenticated facade listens
# on the Railway network. Expose NO public domain for this service.
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --retries=3 CMD curl -fsS http://127.0.0.1:8080/healthz >/dev/null || exit 1
ENTRYPOINT ["node","/opt/clipsflow-gateway/run.mjs"]
CMD []
