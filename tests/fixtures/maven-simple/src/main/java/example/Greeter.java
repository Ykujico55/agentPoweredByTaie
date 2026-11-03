package example;

import org.apache.commons.lang3.StringUtils;

public class Greeter {
    public static String greet(String name) {
        return "Hello, " + StringUtils.defaultIfBlank(name, "stranger") + "!";
    }
}
