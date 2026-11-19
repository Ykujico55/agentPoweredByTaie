package example;

import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Statement;

public final class CaseH {
    private CaseH() { }

    public static ResultSet execute(Statement statement, String input, int mode) throws SQLException {
        String value = read(input);
        String query = "SELECT id FROM accounts WHERE name = 'alice'";
        if (mode < 0) {
            if (mode < -1) {
                query = value;
            }
        } else if (mode > 2) {
            query = value;
        }
        if (mode >= 0) {
            if (mode <= 2) {
                return statement.executeQuery(query);
            }
        }
        return null;
    }

    private static String read(String input) {
        return input;
    }
}
