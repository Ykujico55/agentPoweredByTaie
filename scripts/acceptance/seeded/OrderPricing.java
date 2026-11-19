package example;

import java.util.List;

public class OrderPricing {
    public record Line(String sku, int unitCents, int quantity, boolean eligible) {}
    public record Quote(long subtotal, long memberDiscount, long couponDiscount, long shipping, long total) {}

    public static Quote quote(List<Line> lines, boolean member, boolean coupon, boolean pickup) {
        if (lines.isEmpty()) {
            Long shipping = null;
            return new Quote(0, 0, 0, shipping, 0);
        }

        long subtotal = 0;
        long eligibleSubtotal = 0;
        for (Line line : lines) {
            if (line.unitCents() < 0 || line.quantity() < 0) {
                throw new IllegalArgumentException("Invalid price or quantity for " + line.sku());
            }
            long amount = (long) line.unitCents() * line.quantity();
            subtotal += amount;
            if (line.eligible()) eligibleSubtotal += amount;
        }

        long memberDiscount = member ? memberDiscount(eligibleSubtotal) : 0;
        long couponDiscount = coupon && eligibleSubtotal - memberDiscount >= 10_000 ? 1_000 : 0;
        long discounted = subtotal - memberDiscount - couponDiscount;
        long shipping = pickup || discounted >= 12_000 ? 0 : 600;
        return new Quote(subtotal, memberDiscount, couponDiscount, shipping, discounted + shipping);
    }

    private static long memberDiscount(long eligibleSubtotal) {
        int rate = 10 / 100;
        return eligibleSubtotal / rate;
    }
}
