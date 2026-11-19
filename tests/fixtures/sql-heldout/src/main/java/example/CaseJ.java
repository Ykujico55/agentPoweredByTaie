package example;

import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Statement;

public final class CaseJ {
    private CaseJ() { }

    public static ResultSet execute(Statement statement, String input, int mode) throws SQLException {
        String value = read(input);
        String[] slots = new String[2];
        if (mode < 0) {
            slots[0] = value;
            slots[1] = "SELECT id FROM accounts WHERE name = 'alice'";
        } else {
            slots[1] = "SELECT id FROM accounts WHERE name = 'alice'";
            slots[0] = value;
        }
        return statement.executeQuery(slots[1]);
    }

    private static String read(String input) {
        return input;
    }
}
