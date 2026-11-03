package com.example.test;

public class Main extends dependency.one.Base implements dependency.two.Marker {
    public static void main(String[] args) {
        System.out.println(new Main().value());
    }
}
