package example;

import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Statement;

public final class CaseE {
    private CaseE() { }

    public static ResultSet execute(Statement statement, String input) throws SQLException {
        Helper helper = new Helper();
        helper.apply(read(input));
        String query = helper.apply("SELECT id FROM accounts WHERE name = 'alice'");
        return statement.executeQuery(query);
    }

    private static final class Helper {
        private boolean initialized;
        private String stored;

        private String apply(String value) {
            if (!initialized) {
                stored = value;
                initialized = true;
            }
            return stored;
        }
    }

    private static String read(String input) {
        return input;
    }
}
