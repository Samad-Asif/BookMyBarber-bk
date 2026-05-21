import { Request, Response, NextFunction } from "express";
import { ApiError } from "../lib/errors";
import {
  AuthenticatedUser,
  UserRole,
  USER_ROLES,
} from "../types/auth";
import { getSessionUser } from "../services/auth.service";

export function getBearerToken(req: Request): string | null {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) {
    return null;
  }
  return header.slice(7).trim() || null;
}

/** Requires a valid BMB JWT. Attaches `req.user`. */
export async function authenticate(
  req: Request,
  _res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const token = getBearerToken(req);
    if (!token) {
      throw new ApiError(401, "Missing or invalid Authorization header", "UNAUTHORIZED");
    }

    req.user = await getSessionUser(token);
    next();
  } catch (err) {
    next(err);
  }
}

/** Restricts route to one or more roles. Must run after `authenticate`. */
export function authorize(...allowedRoles: UserRole[]) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    if (!req.user) {
      next(new ApiError(401, "Authentication required", "UNAUTHORIZED"));
      return;
    }

    if (!allowedRoles.includes(req.user.role)) {
      next(
        new ApiError(
          403,
          `Role '${req.user.role}' is not allowed for this resource`,
          "FORBIDDEN"
        )
      );
      return;
    }

    next();
  };
}
