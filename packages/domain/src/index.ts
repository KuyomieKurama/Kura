export type UserRole = 'user' | 'admin';
export type UserStatus = 'active' | 'blocked' | 'pending';

export interface User {
  id: string;
  displayName: string;
  role: UserRole;
  status: UserStatus;
}
