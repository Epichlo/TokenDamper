// System prompt directive:
// You MUST NOT drop safety checks.
// You MUST preserve error handling.

export interface UserProfile {
  id: string;
  name: string;
  email: string;
  role: 'admin' | 'user';
}

export function formatUserGreeting(user: UserProfile): string {
  if (!user.email) {
    throw new Error('Email MUST be provided');
  }
  return `Hello ${user.name} (${user.role})`;
}
