package example;

public class Main {
    public static void main(String[] args) {
        try {
            Integer.parseInt(args[0]);
        } catch (RuntimeException failure) {
            // Demonstration defect: the exception is silently discarded.
        }
    }
}
