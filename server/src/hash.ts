/**
 * Produces the AUTH_PASSWORD_HASH value for a password.
 *   npm run hash-password -- 'the password'
 * Nothing is stored; paste the output into the host's environment settings.
 */
import { hashPassword } from './auth';

const pw = process.argv.slice(2).join(' ');
if (!pw) {
  console.error('Usage: npm run hash-password -- <password>');
  process.exit(1);
}
console.log(hashPassword(pw));
