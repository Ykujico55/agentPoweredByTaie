package example;

import java.io.IOException;
import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Proxy;
import java.nio.file.Files;
import java.nio.file.Path;
import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Statement;
import java.util.ArrayList;
import java.util.List;
import org.junit.After;
import org.junit.AfterClass;
import org.junit.Before;
import org.junit.Test;
import static org.junit.Assert.assertEquals;

public class QueryBehaviorTest {
    private static final String FIXED = "SELECT id FROM accounts WHERE name = 'alice'";
    private static final String ALL = "SELECT id FROM accounts";
    private static final List<String> observations = new ArrayList<>();
    private final List<String> queries = new ArrayList<>();
    private Connection connection;
    private Statement realStatement;
    private Statement statement;

    @Before
    public void prepare() throws SQLException {
        connection = DriverManager.getConnection("jdbc:h2:mem:observations");
        realStatement = connection.createStatement();
        realStatement.execute("CREATE TABLE accounts (id INTEGER PRIMARY KEY, name VARCHAR(40))");
        realStatement.execute("INSERT INTO accounts VALUES (1, 'alice'), (2, 'bob')");
        statement = (Statement) Proxy.newProxyInstance(Statement.class.getClassLoader(),
                new Class<?>[] { Statement.class }, (proxy, method, arguments) -> {
                    if (method.getName().equals("executeQuery")) queries.add((String) arguments[0]);
                    try { return method.invoke(realStatement, arguments); }
                    catch (InvocationTargetException error) { throw error.getCause(); }
                });
    }

    @After
    public void close() throws SQLException {
        if (realStatement != null) realStatement.close();
        if (connection != null) connection.close();
    }

    @AfterClass
    public static void saveObservations() throws IOException {
        Files.createDirectories(Path.of("target"));
        Files.writeString(Path.of("target", "sql-observations.json"),
                "{\"schemaVersion\":1,\"database\":\"H2 2.3.232\",\"observations\":["
                        + String.join(",", observations) + "]}\n");
    }

    private static String json(String value) {
        return value == null ? "null" : "\"" + value.replace("\\", "\\\\").replace("\"", "\\\"") + "\"";
    }

    @FunctionalInterface
    private interface Query {
        ResultSet execute(Statement statement, String input, int mode) throws SQLException;
    }

    private void observe(String caseId, Query operation, String input, int mode,
                         String expectedSql, List<Integer> expectedRows) throws SQLException {
        queries.clear();
        ResultSet result = operation.execute(statement, input, mode);
        List<Integer> rows = null;
        if (result != null) {
            try (result) {
                rows = new ArrayList<>();
                while (result.next()) rows.add(result.getInt(1));
                rows.sort(Integer::compareTo);
            }
        }
        String sql = "[" + String.join(",", queries.stream().map(QueryBehaviorTest::json).toList()) + "]";
        observations.add("{\"caseId\":" + json(caseId) + ",\"input\":" + json(input)
                + ",\"mode\":" + mode + ",\"sql\":" + sql + ",\"rows\":" + rows + "}");
        assertEquals(caseId + " mode=" + mode + " SQL", expectedSql == null ? List.of() : List.of(expectedSql), queries);
        assertEquals(caseId + " mode=" + mode + " rows", expectedRows, rows);
    }

    @Test
    public void caseGBranchRoutes() throws SQLException {
        for (int mode : new int[] {-1, 0, 1, 2, 3, 4}) {
            observe("G", CaseG::execute, FIXED, mode, FIXED, List.of(1));
            boolean inputUsed = mode < 0 || mode > 1 && (mode & 1) == 0;
            observe("G", CaseG::execute, ALL, mode, inputUsed ? ALL : FIXED,
                    inputUsed ? List.of(1, 2) : List.of(1));
        }
    }

    @Test
    public void caseHRangePartitions() throws SQLException {
        for (int mode : new int[] {Integer.MIN_VALUE, -2, -1, 0, 1, 2, 3, Integer.MAX_VALUE}) {
            boolean executes = mode >= 0 && mode <= 2;
            for (String input : new String[] {FIXED, ALL}) {
                observe("H", CaseH::execute, input, mode, executes ? FIXED : null,
                        executes ? List.of(1) : null);
            }
        }
    }

    @Test
    public void caseILoopAndAliases() throws SQLException {
        for (int mode : new int[] {-1, 0, 1, 2}) {
            observe("I", CaseI::execute, FIXED, mode, FIXED, List.of(1));
            observe("I", CaseI::execute, ALL, mode, mode < 0 ? FIXED : ALL,
                    mode < 0 ? List.of(1) : List.of(1, 2));
        }
    }

    @Test
    public void caseJArraySlots() throws SQLException {
        for (int mode : new int[] {-1, 0, 1}) {
            for (String input : new String[] {FIXED, ALL, null}) {
                observe("J", CaseJ::execute, input, mode, FIXED, List.of(1));
            }
        }
    }

    @Test
    public void caseKSwitchAndOverwrite() throws SQLException {
        for (int mode : new int[] {-1, 0, 1, 2, 3}) {
            observe("K", CaseK::execute, FIXED, mode, FIXED, List.of(1));
            boolean inputUsed = mode == 1 || mode == 2;
            observe("K", CaseK::execute, ALL, mode, inputUsed ? ALL : FIXED,
                    inputUsed ? List.of(1, 2) : List.of(1));
        }
    }

    @Test
    public void caseLFinallyOnNormalAndCaughtPaths() throws SQLException {
        for (int mode : new int[] {-1, 0, 1}) {
            for (String input : new String[] {FIXED, ALL, null}) {
                observe("L", CaseL::execute, input, mode, FIXED, List.of(1));
            }
        }
    }
}
