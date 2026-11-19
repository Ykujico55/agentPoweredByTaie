package example;

import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Statement;

public final class CaseI {
    private CaseI() { }

    public static ResultSet execute(Statement statement, String input, int mode) throws SQLException {
        String value = read(input);
        Box first = new Box("SELECT id FROM accounts WHERE name = 'alice'");
        Box second = new Box("SELECT id FROM accounts WHERE name = 'alice'");
        Box cursor = mode < 0 ? second : first;
        for (int index = 0; index < 2; index++) {
            if (index == 0) {
                cursor.query = value;
            } else if (mode == 1) {
                cursor = first;
                cursor.query = value;
            }
        }
        return statement.executeQuery(first.query);
    }

    private static final class Box {
        private String query;

        private Box(String query) {
            this.query = query;
        }
    }

    private static String read(String input) {
        return input;
    }
}
