package example;

import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Statement;

public final class CaseB {
    private CaseB() { }

    public static ResultSet execute(Statement statement, String input) throws SQLException {
        identity(read(input));
        String query = identity("SELECT id FROM accounts WHERE name = 'alice'");
        return statement.executeQuery(query);
    }

    private static String identity(String value) {
        return value;
    }

    private static String read(String input) {
        return input;
    }
}
