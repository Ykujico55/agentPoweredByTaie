package example;

import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Statement;

public final class CaseL {
    private CaseL() { }

    public static ResultSet execute(Statement statement, String input, int mode) throws SQLException {
        String value = read(input);
        Draft draft = new Draft();
        try {
            if (mode < 0) {
                throw new IllegalArgumentException();
            }
            draft.query = value;
            if (mode == 0) {
                throw new IllegalStateException();
            }
        } catch (IllegalArgumentException error) {
            draft.query = value;
        } catch (IllegalStateException error) {
            draft.query = value;
        } finally {
            draft.query = "SELECT id FROM accounts WHERE name = 'alice'";
        }
        return statement.executeQuery(draft.query);
    }

    private static final class Draft {
        private String query;
    }

    private static String read(String input) {
        return input;
    }
}
