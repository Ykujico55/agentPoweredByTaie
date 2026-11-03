package example;

import org.junit.Test;
import static org.junit.Assert.assertEquals;

public class GreeterTest {
    @Test
    public void greetsNamedAndAnonymousUsers() {
        assertEquals("Hello, Tai-e!", Greeter.greet("Tai-e"));
        assertEquals("Hello, stranger!", Greeter.greet(null));
    }
}
