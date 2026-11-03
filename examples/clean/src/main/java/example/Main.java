package example;

public class Main {
    public static void main(String[] args) {
        int value = Integer.parseInt(args.length == 0 ? "0" : args[0]);
        System.out.println(value);
    }
}
