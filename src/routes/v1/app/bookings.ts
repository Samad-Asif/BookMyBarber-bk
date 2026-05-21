import { Router, Request, Response } from "express";
import { authenticate, authorize } from "../../../middleware/auth";
import { asyncHandler } from "../../../middleware/asyncHandler";
import { getSupabaseSecret } from "../../../config/supabase";
import { ApiError } from "../../../lib/errors";
import { getShopOwnerId } from "../../../lib/shop";
import { param } from "../../../lib/params";
import {
  approveBooking,
  createBooking,
  listCustomerBookings,
  listShopBookings,
} from "../../../services/booking.service";

const router = Router();

router.post(
  "/",
  authenticate,
  authorize("customer"),
  asyncHandler(async (req: Request, res: Response) => {
    const {
      shopId,
      serviceId,
      workerId,
      bookingDate,
      startTime,
      requestedDurationMinutes,
      requestedPricePkr,
      customerNotes,
    } = req.body ?? {};

    if (!shopId || !serviceId || !bookingDate || !startTime) {
      throw new ApiError(
        400,
        "shopId, serviceId, bookingDate, and startTime are required",
        "VALIDATION_ERROR"
      );
    }

    const booking = await createBooking({
      customerId: req.user!.id,
      shopId,
      serviceId,
      workerId,
      bookingDate,
      startTime,
      requestedDurationMinutes,
      requestedPricePkr,
      customerNotes,
    });

    res.status(201).json({ booking });
  })
);

router.get(
  "/mine",
  authenticate,
  authorize("customer"),
  asyncHandler(async (req: Request, res: Response) => {
    const bookings = await listCustomerBookings(req.user!.id);
    res.json({ bookings });
  })
);

router.get(
  "/shop/:shopId",
  authenticate,
  authorize("barber"),
  asyncHandler(async (req: Request, res: Response) => {
    const bookings = await listShopBookings(param(req, "shopId"), req.user!.id);
    res.json({ bookings });
  })
);

router.patch(
  "/:id/approve",
  authenticate,
  authorize("barber"),
  asyncHandler(async (req: Request, res: Response) => {
    const { finalDurationMinutes, finalPricePkr, barberNotes } = req.body ?? {};
    const booking = await approveBooking({
      bookingId: param(req, "id"),
      barberId: req.user!.id,
      finalDurationMinutes,
      finalPricePkr,
      barberNotes,
    });
    res.json({ booking });
  })
);

router.patch(
  "/:id/reject",
  authenticate,
  authorize("barber"),
  asyncHandler(async (req: Request, res: Response) => {
    const supabase = getSupabaseSecret();
    const { barberNotes } = req.body ?? {};

    const { data: booking } = await supabase
      .from("bookings")
      .select("*")
      .eq("id", param(req, "id"))
      .single();

    const ownerId = booking ? await getShopOwnerId(booking.shop_id) : null;
    if (!booking || ownerId !== req.user!.id) {
      throw new ApiError(403, "Not authorized", "FORBIDDEN");
    }

    const { data, error } = await supabase
      .from("bookings")
      .update({
        status: "rejected",
        barber_notes: barberNotes ?? null,
        updated_at: new Date().toISOString(),
      })
      .eq("id", param(req, "id"))
      .select()
      .single();

    if (error) throw new ApiError(400, error.message, "UPDATE_FAILED");
    res.json({ booking: data });
  })
);

router.patch(
  "/:id/cancel",
  authenticate,
  authorize("customer", "barber"),
  asyncHandler(async (req: Request, res: Response) => {
    const supabase = getSupabaseSecret();
    const { data: booking } = await supabase
      .from("bookings")
      .select("*")
      .eq("id", param(req, "id"))
      .single();

    if (!booking) throw new ApiError(404, "Booking not found", "NOT_FOUND");

    const isCustomer = booking.customer_id === req.user!.id;
    const ownerId = await getShopOwnerId(booking.shop_id);
    const isOwner = ownerId === req.user!.id;

    if (!isCustomer && !isOwner) {
      throw new ApiError(403, "Not authorized", "FORBIDDEN");
    }

    const { data, error } = await supabase
      .from("bookings")
      .update({
        status: "cancelled",
        updated_at: new Date().toISOString(),
      })
      .eq("id", param(req, "id"))
      .select()
      .single();

    if (error) throw new ApiError(400, error.message, "UPDATE_FAILED");
    res.json({ booking: data });
  })
);

export default router;
