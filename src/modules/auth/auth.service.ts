import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import { prisma } from '../../lib/prisma.js';
import { hashToken } from '../../middleware/auth.middleware.js';

export interface RegisterInput {
  name: string;
  email: string;
  password: string;
}

export interface LoginInput {
  email: string;
  password: string;
  ipAddress?: string;
  userAgent?: string;
}

export class AuthService {
  /**
   * Register a new merchant user and assign default FREE subscription
   */
  static async register(input: RegisterInput) {
    const normalizedEmail = input.email.trim().toLowerCase();

    // Check if email already registered
    const existing = await prisma.user.findUnique({
      where: { email: normalizedEmail },
    });

    if (existing) {
      throw new Error('EMAIL_EXISTS');
    }

    const passwordHash = await bcrypt.hash(input.password, 10);

    // Find FREE plan
    const freePlan = await prisma.plan.findUnique({
      where: { code: 'FREE' },
    });

    // Create user and initial subscription in a single transaction
    const user = await prisma.$transaction(async (tx) => {
      const newUser = await tx.user.create({
        data: {
          name: input.name.trim(),
          email: normalizedEmail,
          passwordHash,
          role: 'USER', // Always USER for public registration
          status: 'ACTIVE',
        },
        select: {
          id: true,
          email: true,
          name: true,
          role: true,
          status: true,
          createdAt: true,
        },
      });

      if (freePlan) {
        const now = new Date();
        const endOfPeriod = new Date();
        endOfPeriod.setFullYear(endOfPeriod.getFullYear() + 10); // 10-year free validity

        await tx.subscription.create({
          data: {
            userId: newUser.id,
            planId: freePlan.id,
            status: 'ACTIVE',
            currentPeriodStart: now,
            currentPeriodEnd: endOfPeriod,
            autoRenew: true,
          },
        });
      }

      return newUser;
    });

    return user;
  }

  /**
   * Authenticate user, generate secure revocable session token (7-day maximum lifetime)
   */
  static async login(input: LoginInput) {
    const normalizedEmail = input.email.trim().toLowerCase();

    const user = await prisma.user.findUnique({
      where: { email: normalizedEmail },
    });

    if (!user) {
      throw new Error('INVALID_CREDENTIALS');
    }

    const passwordValid = await bcrypt.compare(input.password, user.passwordHash);
    if (!passwordValid) {
      throw new Error('INVALID_CREDENTIALS');
    }

    if (user.status !== 'ACTIVE') {
      throw new Error('ACCOUNT_SUSPENDED');
    }

    // Generate secure 32-byte random session token
    const rawSessionToken = crypto.randomBytes(32).toString('hex');
    const tokenHash = hashToken(rawSessionToken);

    // Final Owner Decision: Session lifetime = 7 days
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + 7);

    await prisma.authSession.create({
      data: {
        userId: user.id,
        tokenHash,
        expiresAt,
        ipAddress: input.ipAddress,
        userAgent: input.userAgent,
      },
    });

    return {
      sessionToken: rawSessionToken,
      expiresAt,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
        status: user.status,
        createdAt: user.createdAt,
      },
    };
  }

  /**
   * Revoke active session
   */
  static async logout(rawSessionToken: string) {
    const tokenHash = hashToken(rawSessionToken);
    try {
      await prisma.authSession.delete({
        where: { tokenHash },
      });
    } catch {
      // Ignore if already deleted
    }
  }

  /**
   * Fetch current user profile with subscription and metadata
   */
  static async getMe(userId: string) {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        email: true,
        name: true,
        role: true,
        status: true,
        createdAt: true,
        subscriptions: {
          where: { status: 'ACTIVE' },
          orderBy: { createdAt: 'desc' },
          take: 1,
          include: {
            plan: {
              select: {
                code: true,
                name: true,
                monthlyTransactionLimit: true,
                paymentAccountLimit: true,
              },
            },
          },
        },
        apiCredential: {
          select: {
            keyPrefix: true,
            createdAt: true,
            rotatedAt: true,
            lastUsedAt: true,
          },
        },
      },
    });

    if (!user) {
      throw new Error('USER_NOT_FOUND');
    }

    const currentSubscription = user.subscriptions[0] || null;

    return {
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
      status: user.status,
      createdAt: user.createdAt,
      subscription: currentSubscription
        ? {
            status: currentSubscription.status,
            currentPeriodEnd: currentSubscription.currentPeriodEnd,
            plan: currentSubscription.plan,
          }
        : null,
      apiKey: user.apiCredential
        ? {
            exists: true,
            keyPrefix: user.apiCredential.keyPrefix,
            createdAt: user.apiCredential.createdAt,
            rotatedAt: user.apiCredential.rotatedAt,
            lastUsedAt: user.apiCredential.lastUsedAt,
          }
        : {
            exists: false,
          },
    };
  }
}
