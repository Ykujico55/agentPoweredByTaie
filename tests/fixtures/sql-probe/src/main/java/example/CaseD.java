package example;

import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Statement;

public final class CaseD {
    private CaseD() { }

    public static ResultSet execute(Statement statement, String input) throws SQLException {
        read(input);
        return statement.executeQuery("SELECT id FROM accounts WHERE name = 'alice'");
    }

    private static String read(String input) {
        return input;
    }
}
