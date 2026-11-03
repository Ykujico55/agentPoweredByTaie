package example;

public class Main {
    public static int divide(int numerator, int denominator) {
        if (denominator == 0) {
            throw new IllegalArgumentException("denominator must not be zero");
        }
        return numerator / denominator;
    }

    public static void main(String[] args) {
        System.out.println(divide(12, 3));
    }
}
