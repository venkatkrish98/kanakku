import crypto from 'node:crypto';
import { eq } from 'drizzle-orm';
import { getDatabase, closeDatabase, users } from '../index.js';

export interface RotateKeyResult {
  email: string;
  keyHash: string;
  rawKey?: string;
}

/**
 * Key rotation utility for Kanakku operators and owners.
 * Revokes any existing API key for the target email and replaces its hash with a fresh cryptographic secret.
 * If NEW_API_KEY is not provided, generates a new 48-hex secret and displays it once to the administrator.
 */
export async function rotateApiKey(
  userEmail: string = 'ramesh@kanakku.in',
  explicitKey?: string,
): Promise<RotateKeyResult> {
  const db = getDatabase();
  const provided = explicitKey || process.env['NEW_API_KEY'];
  const rawKey = provided || crypto.randomBytes(24).toString('hex');
  const freshHash = crypto.createHash('sha256').update(rawKey).digest('hex');

  const updated = await db
    .update(users)
    .set({ apiKeyHash: freshHash })
    .where(eq(users.email, userEmail))
    .returning({ id: users.id, email: users.email });

  if (updated.length === 0) {
    throw new Error(`User with email "${userEmail}" not found in database.`);
  }

  console.log(`[REVOKED & ROTATED] API key for ${userEmail} has been rotated.`);
  console.log(`Stored SHA-256 Hash: ${freshHash}`);

  if (provided) {
    console.log(`Rotated using operator-supplied secret from NEW_API_KEY.`);
    return { email: userEmail, keyHash: freshHash };
  } else {
    console.log('----------------------------------------------------------------------');
    console.log('ONE-TIME DISPLAY: Generated new API key. Store this securely:');
    console.log(`  ${rawKey}`);
    console.log('----------------------------------------------------------------------');
    return { email: userEmail, keyHash: freshHash, rawKey };
  }
}

// Execute when invoked directly
if (process.argv[1]?.endsWith('rotate-key.ts') || process.argv[1]?.endsWith('rotate-key.js')) {
  const targetEmail = process.argv[2] || 'ramesh@kanakku.in';
  rotateApiKey(targetEmail)
    .then(async () => {
      await closeDatabase();
      process.exit(0);
    })
    .catch(async (err) => {
      console.error('Failed to rotate API key:', err);
      await closeDatabase();
      process.exit(1);
    });
}
