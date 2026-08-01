import fs from 'fs';
import path from 'path';

const root = path.resolve(__dirname, '../..');

describe('Plexer producer migration contract', () => {
  const contractPath = path.join(
    root,
    'docs/contracts/ingress-producer-contract.v1.json',
  );
  const contract = JSON.parse(fs.readFileSync(contractPath, 'utf8'));

  it('declares Bearer-only authentication and deterministic retry behavior', () => {
    expect(contract.authentication).toEqual({
      scheme: 'Bearer',
      server_env: 'PLEXER_TOKEN',
      header_template: 'Authorization: Bearer ${PLEXER_TOKEN}',
      x_auth_accepted: false,
    });
    expect(contract.retry).toEqual({
      '401': 'configuration_error_do_not_retry_without_change',
      '429': 'retry_after_header_seconds',
      '503': 'retryable',
    });
  });

  it('keeps the in-repo runtime proof authenticated', () => {
    const proof = fs.readFileSync(
      path.join(root, 'scripts/prove-runtime-usefulness.sh'),
      'utf8',
    );
    expect(proof).toContain('-e PLEXER_TOKEN="$TOKEN"');
    expect(proof).toContain('PLEXER_TOKEN="$TOKEN"');
    expect(proof).toContain('-H "Authorization: Bearer $TOKEN"');
  });

  it('pins the required external Grabowski update without modifying Grabowski here', () => {
    const grabowski = contract.audited_producers.find(
      (producer: { producer: string }) => producer.producer === 'grabowski-agent-run-outbox',
    );
    expect(grabowski).toMatchObject({
      repository: 'heimgewebe/grabowski',
      status: 'external_update_required',
      token_env: 'GRABOWSKI_PLEXER_TOKEN',
      required_header_template: 'Authorization: Bearer ${GRABOWSKI_PLEXER_TOKEN}',
      required_test: 'test_send_event_posts_bearer_token_to_plexer',
    });

    const migration = fs.readFileSync(
      path.join(root, 'docs/ingress-security-and-retention.md'),
      'utf8',
    );
    expect(migration).toContain('Grabowski is intentionally not edited on this branch');
    expect(migration).toContain('test_send_event_posts_bearer_token_to_plexer');
  });

  it('records already-Bearer-compatible metarepo and WGX producers as token-required', () => {
    const statuses = Object.fromEntries(
      contract.audited_producers.map((producer: { producer: string; status: string }) => [
        producer.producer,
        producer.status,
      ]),
    );
    expect(statuses['metarepo-notify-workflow']).toBe('bearer_compatible_token_now_required');
    expect(statuses['wgx-heimgeist-emitter']).toBe('bearer_compatible_token_now_required');
  });
});
