/**
 * Which existing profile a registration from someone who can't manage the
 * profiles on that email (not signed in, or another account) goes on. They
 * never see those profiles, so an email alone mustn't decide: a parent
 * registering their second child on the family email would otherwise land
 * on the first child's profile. Only a profile with the same first and last
 * name is reused; anything else makes a new profile on that email.
 *
 * Pure; tested in registrationIdentity.test.ts.
 */
const norm = (v: string | null | undefined) => (v ?? "").trim().replace(/\s+/g, " ").toLowerCase();

export function profileMatchingName<T extends { id: number; firstName: string | null; lastName: string | null }>(
  sameEmail: T[],
  firstName: unknown,
  lastName: unknown,
): T | null {
  const first = norm(typeof firstName === "string" ? firstName : "");
  const last = norm(typeof lastName === "string" ? lastName : "");
  if (!first || !last) return null;
  return [...sameEmail].sort((a, b) => a.id - b.id)
    .find(r => norm(r.firstName) === first && norm(r.lastName) === last) ?? null;
}
