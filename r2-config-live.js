window.R2_DATA_CONFIG = {
  // R2 public endpoint does not send browser CORS headers. The downloader
  // keeps a local manifest + CSV cache so Safari always loads real ticks.
  manifestUrl: 'local-r2-manifest.json',
  publicBaseUrl: '.',
};
