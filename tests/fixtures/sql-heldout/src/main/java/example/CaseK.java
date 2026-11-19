package example;

import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Statement;

public final class CaseK {
    private CaseK() { }

    public static ResultSet execute(Statement statement, String input, int mode) throws SQLException {
        String value = read(input);
        String query = "SELECT id FROM accounts WHERE name = 'alice'";
        switch (mode) {
            case 0:
                query = value;
            case 1:
                if (mode == 1) {
                    query = value;
                }
                break;
            case 2:
                query = value;
                break;
            default:
                query = "SELECT id FROM accounts WHERE name = 'alice'";
        }
        if (mode == 0) {
            query = "SELECT id FROM accounts WHERE name = 'alice'";
        }
        return statement.executeQuery(query);
    }

    private static String read(String input) {
        return input;
    }
}
