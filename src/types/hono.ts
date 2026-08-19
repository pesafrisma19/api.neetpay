import type { Role, UserStatus, AuthSession, ApiCredential } from '@prisma/client';

export type AuthUser = {
  id: string;
  email: string;
  name: string;
  role: Role;
  status: UserStatus;
  hasDynamicAccess: boolean;
  dynamicActivatedAt?: Date | null;
  createdAt: Date;
  updatedAt?: Date;
};

export type MerchantUser = {
  id: string;
  email: string;
  name: string;
  role: Role;
  status: UserStatus;
  hasDynamicAccess: boolean;
};

export type AppEnv = {
  Variables: {
    user: AuthUser;
    session: AuthSession;
    merchantUser: MerchantUser;
    apiCredential: ApiCredential;
  };
};
