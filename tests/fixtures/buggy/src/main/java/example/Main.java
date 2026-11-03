package example;

public class Main {
    public static void main(String[] args) {
        try {
            Integer.parseInt(args[0]);
        } catch (RuntimeException failure) {
            // BUG: the failure disappears without any handling or explanation.
        }
    }
}
