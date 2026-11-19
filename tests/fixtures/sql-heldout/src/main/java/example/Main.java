package example;

import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Statement;

public final class Main {
    private Main() { }

    public static void main(String[] args) throws SQLException {
        String input = args.length > 0 ? args[0] : "SELECT id FROM accounts WHERE name = 'alice'";
        int mode = args.length > 1 ? Integer.parseInt(args[1]) : 0;
        try (Connection connection = DriverManager.getConnection("jdbc:h2:mem:case-entry");
             Statement statement = connection.createStatement()) {
            statement.execute("CREATE TABLE accounts (id INTEGER PRIMARY KEY, name VARCHAR(40))");
            statement.execute("INSERT INTO accounts VALUES (1, 'alice'), (2, 'bob')");
            consume(CaseG.execute(statement, input, mode));
            consume(CaseH.execute(statement, input, mode));
            consume(CaseI.execute(statement, input, mode));
            consume(CaseJ.execute(statement, input, mode));
            consume(CaseK.execute(statement, input, mode));
            consume(CaseL.execute(statement, input, mode));
        }
    }

    private static void consume(ResultSet result) throws SQLException {
        if (result == null) return;
        try (result) {
            while (result.next()) System.out.println(result.getInt(1));
        }
    }
}
