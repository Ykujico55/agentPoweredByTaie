package example;

import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Statement;

public final class CaseG {
    private CaseG() { }

    public static ResultSet execute(Statement statement, String input, int mode) throws SQLException {
        String value = read(input);
        String query;
        if (mode < 0) {
            query = value;
        } else if (mode > 1) {
            query = route(value, mode);
        } else {
            query = route("SELECT id FROM accounts WHERE name = 'alice'", mode);
        }
        return statement.executeQuery(query);
    }

    private static String route(String text, int mode) {
        if ((mode & 1) == 0) {
            return text;
        }
        return "SELECT id FROM accounts WHERE name = 'alice'";
    }

    private static String read(String input) {
        return input;
    }
}
