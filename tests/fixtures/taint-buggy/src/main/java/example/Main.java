package example;

/** A small configured information-flow example; source/sink policy is in taint.yml. */
public class Main {
    public static void main(String[] args) {
        String input = args.length == 0 ? "demo-input" : args[0];
        String untrusted = source(input);
        String forwarded = relay(untrusted);
        sink(forwarded);
    }

    public static String source(String input) {
        return input;
    }

    public static String relay(String value) {
        return value;
    }

    public static void sink(String value) {
        System.out.println(value);
    }
}
