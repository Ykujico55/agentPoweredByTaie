package example;

import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Statement;

public final class Main {
    private Main() { }

    public static void main(String[] args) throws SQLException {
        String input = args.length > 0 ? args[0] : "alice";
        boolean flag = args.length > 1 && Boolean.parseBoolean(args[1]);
        String queryInput = args.length > 2 ? args[2] : "SELECT id FROM accounts WHERE name = 'alice'";
        try (Connection connection = DriverManager.getConnection("jdbc:h2:mem:probe-entry");
             Statement statement = connection.createStatement()) {
            statement.execute("CREATE TABLE accounts (id INTEGER PRIMARY KEY, name VARCHAR(40))");
            statement.execute("INSERT INTO accounts VALUES (1, 'alice'), (2, 'bob')");
            consume(CaseA.execute(statement, input));
            consume(CaseB.execute(statement, input));
            consume(CaseC.execute(statement, input, flag));
            consume(CaseD.execute(statement, input));
            consume(CaseE.execute(statement, queryInput));
            consume(CaseF.execute(statement, queryInput));
        }
    }

    private static void consume(ResultSet result) throws SQLException {
        if (result == null) return;
        try (result) {
            while (result.next()) System.out.println(result.getInt(1));
        }
    }
}
