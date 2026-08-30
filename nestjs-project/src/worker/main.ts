/**
 * Entrypoint placeholder for the isolated FFmpeg video-worker process.
 * SI-03.7 will replace this stub with the BullMQ consumer.
 */
void (async () => {
  const { bootstrapVideoWorker } = await import('./video-worker.js');
  await bootstrapVideoWorker();
})();
