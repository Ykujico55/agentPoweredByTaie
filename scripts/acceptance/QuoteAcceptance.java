import example.OrderPricing;
import example.OrderPricing.Line;
import example.OrderPricing.Quote;
import java.util.List;

public class QuoteAcceptance {
    private static int passed;
    private static int failed;

    public static void main(String[] args) {
        check("empty delivery order", () -> expect(List.of(), true, true, false,
                new Quote(0, 0, 0, 0, 0)));
        check("no coupon requested, delivery below threshold", () -> expect(
                List.of(new Line("book", 11_999, 1, true)), false, false, false,
                new Quote(11_999, 0, 0, 600, 12_599)));
        check("ineligible goods cannot top up the coupon threshold", () -> expect(
                List.of(new Line("lamp", 11_110, 1, true), new Line("bulb", 2_100, 1, false)),
                true, true, false, new Quote(13_210, 1_111, 0, 0, 12_099)));
        check("exact coupon and free delivery thresholds after discounts", () -> expect(
                List.of(new Line("lamp", 11_111, 1, true), new Line("bulb", 3_000, 1, false)),
                true, true, false, new Quote(14_111, 1_111, 1_000, 0, 12_000)));
        check("one cent below free delivery after coupon", () -> expect(
                List.of(new Line("lamp", 11_111, 1, true), new Line("bulb", 2_999, 1, false)),
                true, true, false, new Quote(14_110, 1_111, 1_000, 600, 12_599)));
        check("round once across quantities and lines, pickup has no fee", () -> expect(
                List.of(new Line("clip", 3, 3, true), new Line("pen", 8, 1, true),
                        new Line("gift", 0, 1, true)),
                true, false, true, new Quote(17, 1, 0, 0, 16)));
        check("nonmember can redeem a coupon", () -> expect(
                List.of(new Line("set", 2_500, 4, true)), false, true, false,
                new Quote(10_000, 0, 1_000, 600, 9_600)));
        check("line amount exceeds the 32-bit range", () -> expect(
                List.of(new Line("machine", 1_500_000_000, 2, true)), true, true, false,
                new Quote(3_000_000_000L, 300_000_000, 1_000, 0, 2_699_999_000L)));
        check("negative unit price rejected", () -> expectRejected(-1, 1));
        check("zero quantity rejected", () -> expectRejected(100, 0));

        System.out.printf("%d/%d passed%n", passed, passed + failed);
        if (failed > 0) System.exit(1);
    }

    private static void expect(List<Line> lines, boolean member, boolean coupon, boolean pickup, Quote expected) {
        Quote actual = OrderPricing.quote(lines, member, coupon, pickup);
        if (!expected.equals(actual)) throw new AssertionError("expected " + expected + ", got " + actual);
    }

    private static void expectRejected(int unitCents, int quantity) {
        try {
            OrderPricing.quote(List.of(new Line("pen", unitCents, quantity, true)), false, false, false);
        } catch (IllegalArgumentException expected) {
            return;
        }
        throw new AssertionError("expected IllegalArgumentException");
    }

    private static void check(String name, Runnable test) {
        try {
            test.run();
            passed++;
            System.out.println("PASS " + name);
        } catch (RuntimeException | AssertionError error) {
            failed++;
            System.out.println("FAIL " + name + " - " + error);
        }
    }
}
