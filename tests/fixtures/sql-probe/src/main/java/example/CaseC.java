package example;

import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Statement;

public final class CaseC {
    private CaseC() { }

    public static ResultSet execute(Statement statement, String input, boolean flag) throws SQLException {
        String query = "SELECT id FROM accounts WHERE name = 'alice'";
        if (flag) {
            query = read(input);
        }
        if (!flag) {
            return statement.executeQuery(query);
        }
        return null;
    }

    private static String read(String input) {
        return input;
    }
}
