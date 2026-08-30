/**
 * Entrypoint placeholder for the transactional outbox relay process.
 * SI-03.6 will replace this stub with the database poll + dispatch loop.
 */
void (async () => {
  const { bootstrapOutboxRelay } = await import('./outbox-relay.js');
  await bootstrapOutboxRelay();
})();
