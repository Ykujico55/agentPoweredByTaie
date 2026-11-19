package example;

import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Statement;

public final class CaseA {
    private CaseA() { }

    public static ResultSet execute(Statement statement, String input) throws SQLException {
        String value = read(input);
        String query = "SELECT id FROM accounts WHERE name = '".concat(value).concat("'");
        return statement.executeQuery(query);
    }

    private static String read(String input) {
        return input;
    }
}
